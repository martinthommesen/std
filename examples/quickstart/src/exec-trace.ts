/**
 * Tracing every program a script runs, to prove that no password reaches a
 * process's arguments (`ps`, `/proc/<pid>/cmdline`).
 *
 * The script runs under `strace -f -e trace=execve`: `-f` follows every
 * descendant, so each execve shows up, whatever shell construct, PATH
 * trick or interpreter started it. The log is parsed here, and
 * `checkTrace` refuses any argument that holds a password (as is or
 * JSON-escaped) or an `authorization: Bearer` header, any failed execve,
 * and a trace that lacks the programs the run must have started, so an
 * empty or broken trace cannot pass. Problems name the program and the
 * argument's index, never the secret.
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

import { Effect, Schema } from "effect";

import { exitCode, spawnGroup } from "./process-group.ts";
import { Cursor } from "./trace-cursor.ts";

/** One execve from the trace. */
export interface Execve {
  readonly pid: number;
  /** The path passed to execve. */
  readonly program: string;
  readonly argv: readonly string[];
  /** `0`, or the error, such as `-1 ENOENT (No such file or directory)`. */
  readonly result: string;
  /** Whether strace cut the argument list short. */
  readonly truncated: boolean;
}

/** A parsed trace. */
export interface Trace {
  readonly calls: readonly Execve[];
  /** Execve lines that did not parse. */
  readonly unparsed: number;
}

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
  "trace=execve",
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

const EXECVE = /^(?<pid>\d+) +execve\((?<call>.*)$/u;
const RESUMED = /^(?<pid>\d+) +<\.\.\. execve resumed>(?<rest>.*)$/u;
const UNFINISHED = " <unfinished ...>";

/**
 * Parses one complete execve call, from after `execve(`.
 * @param pid - The calling process.
 * @param call - `"<path>", [<argv>], <env>) = <result>`.
 * @returns The execve, or undefined when the text does not parse.
 */
const parseCall = (pid: number, call: string): Execve | undefined => {
  const cursor = new Cursor(call);
  const program = cursor.string();

  if (program === undefined || !cursor.skip(", [")) {
    return undefined;
  }

  const argv: string[] = [];
  let truncated = false;

  while (!cursor.skip("]")) {
    cursor.skip(", ");

    if (cursor.skip("...")) {
      truncated = true;
    } else {
      const argument = cursor.string();

      if (argument === undefined) {
        return undefined;
      }

      argv.push(argument);
    }
  }

  const { rest } = cursor;
  const close = rest.indexOf(")");
  const after = close === -1 ? "" : rest.slice(close + 1).trimStart();
  const result = after.startsWith("=") ? after.slice(1).trim() : undefined;

  return result === undefined
    ? undefined
    : { argv, pid, program, result, truncated };
};

/**
 * Every execve in a trace log, in order. A call strace split across lines
 * (`<unfinished ...>`, `<... execve resumed>`) is joined.
 * @param log - The log.
 * @returns The calls, and the execve lines that did not parse.
 */
export const parseTrace = (log: string): Trace => {
  const pending = new Map<number, string>();
  const calls: Execve[] = [];
  let unparsed = 0;

  const complete = (pid: number, call: string) => {
    const parsed = parseCall(pid, call);

    if (parsed === undefined) {
      unparsed += 1;
    } else {
      calls.push(parsed);
    }
  };

  for (const line of log.split("\n")) {
    const started = EXECVE.exec(line)?.groups;
    const resumed = RESUMED.exec(line)?.groups;

    if (started !== undefined) {
      const pid = Number(started.pid);
      const call = started.call ?? "";

      if (call.endsWith(UNFINISHED)) {
        pending.set(pid, call.slice(0, -UNFINISHED.length));
      } else {
        complete(pid, call);
      }
    } else if (resumed !== undefined) {
      const pid = Number(resumed.pid);

      complete(pid, `${pending.get(pid) ?? ""}${resumed.rest ?? ""}`);
      pending.delete(pid);
    }
  }

  return { calls, unparsed: unparsed + pending.size };
};

/**
 * The problems in a parsed trace.
 * @param trace - The parsed trace.
 * @param secrets - The run's passwords.
 * @param expected - Programs that must have run.
 * @returns One line per problem, naming programs and argument indexes but
 *   never a secret; empty when the trace is clean.
 */
export const checkTrace = (
  trace: Trace,
  secrets: readonly string[],
  expected: readonly ExpectedProgram[]
): readonly string[] => {
  const needles = secrets.flatMap((secret) => [
    secret,
    JSON.stringify(secret).slice(1, -1),
  ]);

  const perCall = trace.calls.flatMap((call, number) => {
    const name = `execve ${number + 1} (${path.basename(call.program)})`;

    const leaks = call.argv.flatMap((argument, index) => {
      if (needles.some((needle) => argument.includes(needle))) {
        return [`${name}: argument ${index} holds a password`];
      }

      return /bearer /iu.test(argument)
        ? [`${name}: argument ${index} holds an authorization header`]
        : [];
    });

    const failed = call.result.startsWith("0")
      ? []
      : [`${name} failed: ${call.result.split(" ")[1] ?? call.result}`];

    const cut = call.truncated
      ? [`${name}: strace shortened its arguments`]
      : [];

    return [...leaks, ...failed, ...cut];
  });

  const missing = expected.flatMap((program) =>
    trace.calls.some((call) => program.ran(call))
      ? []
      : [`no execve of ${program.name} in the trace`]
  );

  const broken =
    trace.unparsed > 0 ? [`${trace.unparsed} execve lines did not parse`] : [];

  return [...perCall, ...missing, ...broken];
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
