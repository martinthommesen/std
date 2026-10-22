/**
 * Tracing every program a script runs, to catch a password or a session
 * token in a process's arguments (`ps`, `/proc/<pid>/cmdline`).
 *
 * Threat model. This guards against accidental regressions in our own
 * example script: someone adding `--arg password`, a token in a header or
 * cookie argument, or a new tool that takes a secret as an argument. It
 * does not stop a deliberately adversarial script author, who can leak a
 * secret in many ways no tracer sees (a file, a socket, the environment, a
 * FIFO to a process started earlier). Coverage is limited to the script and
 * its descendants: a process that already runs outside that tree is not
 * traced.
 *
 * The script runs under `strace -f -e trace=execve,execveat`: `-f` follows
 * every descendant, so every program start shows up, whatever shell
 * construct, PATH trick or interpreter caused it. `trace-parse.ts` reads
 * the log and fails closed. `checkTrace` then refuses any argument that
 * holds a password (as is or JSON-escaped) or a token-shaped value (the
 * server's session-token format, `sessionTokensIn`), any failed call, any
 * string or list strace shortened, any unreadable line, and a trace that
 * lacks the programs the run must have started, so an empty or broken
 * trace cannot pass. Every problem is redacted before it is reported: no
 * password or token-shaped value reaches a diagnostic, program names
 * included.
 *
 * Linux only (strace and ptrace). The log holds every argument, so it is
 * written to a private temporary directory, mode 0600, and removed when
 * the scope closes, on success and failure alike.
 */
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sessionTokensIn } from "@std/server/auth/sessions";
import { Effect, Schema } from "effect";

import { exitCode, spawnGroup } from "./process-group.ts";
import type { Execve, Trace } from "./trace-parse.ts";
import { parseTrace } from "./trace-parse.ts";

export type { Execve, Trace } from "./trace-parse.ts";

/** A program the trace must show, so an empty trace cannot pass. */
export interface ExpectedProgram {
  readonly name: string;
  readonly ran: (execve: Execve) => boolean;
}

/** strace is not installed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class StraceMissing extends Schema.TaggedError<
  StraceMissing,
  { readonly brand: unique symbol }
>()("StraceMissing", {}) {
  /**
   * Says how to install it.
   * @returns The message.
   */
  override get message(): string {
    return `${this._tag}: pnpm quickstart:ci traces the script with strace (Linux), which is not installed; install it, for example with: sudo apt-get install -y strace`;
  }
}

/**
 * Where strace is, on a search path.
 * @param searchPath - A PATH value (default: this process's PATH).
 * @returns Its path, or `StraceMissing`, which says how to install it.
 */
export const findStrace = (searchPath: string = process.env.PATH ?? "") =>
  Effect.suspend(() => {
    const found = searchPath
      .split(path.delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => path.join(directory, "strace"))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);

          return true;
        } catch {
          return false;
        }
      });

    return found === undefined
      ? Effect.fail(new StraceMissing())
      : Effect.succeed(found);
  });

/** A private trace log. */
export interface TraceLog {
  readonly file: string;
  readonly read: Effect.Effect<string>;
}

/**
 * A trace log in a new private directory (mode 0700), created with mode
 * 0600 before strace opens it, so strace keeps that mode. Both are removed
 * when the scope closes.
 */
export const traceLog = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(tmpdir(), "std-quickstart-trace-"));
    const file = path.join(directory, "execve.log");

    writeFileSync(file, "", { mode: 0o600 });

    return { directory, file };
  }),
  ({ directory }) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
).pipe(
  Effect.map(({ file }): TraceLog => ({
    file,
    read: Effect.sync(() => readFileSync(file, "utf-8")),
  }))
);

/**
 * The arguments that run a command under strace, tracing every execve of
 * it and its descendants into `log`.
 * @param log - The trace log.
 * @param command - The command.
 * @param args - Its arguments.
 * @returns strace's arguments.
 */
export const traceArguments = (
  log: string,
  command: string,
  args: readonly string[]
): readonly string[] => [
  "-f",
  "-qq",
  "-e",
  "trace=execve,execveat",
  "-e",
  "signal=none",
  "-s",
  "1048576",
  "-o",
  log,
  "--",
  command,
  ...args,
];

/**
 * Replaces every credential in a text: the passwords (as is and
 * JSON-escaped) and every token-shaped value.
 * @param text - A diagnostic.
 * @param needles - The passwords and their escaped forms.
 * @returns The text without them.
 */
const redact = (text: string, needles: readonly string[]): string => {
  let redacted = text;

  for (const needle of needles) {
    redacted = redacted.replaceAll(needle, "<password>");
  }

  for (const token of sessionTokensIn(redacted)) {
    redacted = redacted.replaceAll(token, "<token>");
  }

  return redacted;
};

/**
 * The problems of one call.
 * @param call - The call.
 * @param number - Its position in the trace, from 1.
 * @param needles - The passwords and their escaped forms.
 * @returns Its problems, not yet redacted.
 */
const callProblems = (
  call: Execve,
  number: number,
  needles: readonly string[]
): readonly string[] => {
  const shown = call.program === "" ? (call.argv[0] ?? "") : call.program;
  const name = `${call.kind} ${number} (${path.basename(shown)})`;

  const credentialIn = (text: string): string | undefined => {
    if (needles.some((needle) => text.includes(needle))) {
      return "a password";
    }

    return sessionTokensIn(text).length > 0 ? "a session token" : undefined;
  };

  const inPath = credentialIn(call.program);

  const pathLeak =
    inPath === undefined ? [] : [`${name}: its path holds ${inPath}`];

  const leaks = call.argv.flatMap((argument, index) => {
    const found = credentialIn(argument);

    return found === undefined
      ? []
      : [`${name}: argument ${index} holds ${found}`];
  });

  const failed = call.result === "0" ? [] : [`${name} failed: ${call.result}`];
  const cut = call.truncated ? [`${name}: strace shortened an argument`] : [];

  return [...pathLeak, ...leaks, ...failed, ...cut];
};

/**
 * The problems in a parsed trace, redacted.
 * @param trace - The parsed trace.
 * @param secrets - The run's passwords.
 * @param expected - Programs that must have run.
 * @returns One line per problem, naming calls, programs and argument
 *   indexes, with every credential replaced; empty when the trace is clean.
 */
export const checkTrace = (
  trace: Trace,
  secrets: readonly string[],
  expected: readonly ExpectedProgram[]
): readonly string[] => {
  const needles = secrets.flatMap((secret) =>
    secret.length === 0 ? [] : [secret, JSON.stringify(secret).slice(1, -1)]
  );

  const missing = expected.flatMap((wanted) =>
    trace.calls.some((call) => wanted.ran(call))
      ? []
      : [`no execve of ${wanted.name} in the trace`]
  );

  return [
    ...trace.problems,
    ...trace.calls.flatMap((call, index) =>
      callProblems(call, index + 1, needles)
    ),
    ...missing,
  ].map((problem) => redact(problem, needles));
};

/**
 * A program the trace must show, recognized by the file name it ran.
 * @param name - The program's file name, such as `curl`.
 * @returns The expectation.
 */
export const program = (name: string): ExpectedProgram => ({
  name,
  ran: (call) => path.basename(call.program) === name,
});

/** What a traced run did. */
export interface TracedRun {
  /** The script's exit code, or null when a signal ended it. */
  readonly code: number | null;
  /** `checkTrace`'s problems; empty when the trace is clean. */
  readonly problems: readonly string[];
  /** How many execve calls the trace holds. */
  readonly calls: number;
}

/**
 * Runs a bash script under strace, in its own process group (ended and
 * awaited when the run ends or is interrupted), and checks the trace. The
 * log is removed afterwards, whatever happened.
 * @param options - The script, its environment, the secrets and the
 *   programs that must run.
 * @returns The exit code and the trace's problems.
 */
export const traceScript = Effect.fn("ExecTrace.traceScript")(
  function* traceScript(options: {
    readonly script: string;
    readonly env: NodeJS.ProcessEnv;
    readonly secrets: readonly string[];
    readonly expected: readonly ExpectedProgram[];
  }) {
    const strace = yield* findStrace();
    const log = yield* traceLog;

    const child = yield* spawnGroup(
      strace,
      traceArguments(log.file, "bash", [options.script]),
      { env: options.env, stdio: "inherit" }
    );

    const code = yield* exitCode(child);
    const trace = parseTrace(yield* log.read);

    return {
      calls: trace.calls.length,
      code,
      problems: checkTrace(trace, options.secrets, options.expected),
    } satisfies TracedRun;
  },
  Effect.scoped
);
