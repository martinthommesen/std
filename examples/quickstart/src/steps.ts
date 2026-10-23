/**
 * The steps `pnpm quickstart:ci` and `pnpm release-compat:ci` share: run a
 * command in its own process group, start `std serve` and wait until it
 * listens. Every child is ended with its process group when its scope
 * closes (`process-group.ts`).
 */
import { Console, Effect, Schedule, Schema } from "effect";

import { traceScript } from "./exec-trace.ts";
import { exitCode, spawnGroup } from "./process-group.ts";

/** How long `std serve` may take to listen: 150 polls, 200 ms apart. */
const LISTEN_POLLS = 150;
const LISTEN_POLL_INTERVAL = "200 millis";

/** The line `std serve` logs once it listens (Effect's Node HTTP server). */
const LISTENING = /Listening on (?<url>http:\/\/[\d.:]+)/u;

/** A step of the run failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class QuickstartStepFailed extends Schema.TaggedError<
  QuickstartStepFailed,
  { readonly brand: unique symbol }
>()("QuickstartStepFailed", {
  code: Schema.NullOr(Schema.Number),
  detail: Schema.String,
  reason: Schema.Literals(["exited", "notListening", "trace"]),
  step: Schema.String,
}) {
  /**
   * Names the step and what went wrong.
   * @returns The message.
   */
  override get message(): string {
    if (this.reason === "exited") {
      return `${this.step} exited with ${String(this.code)}`;
    }

    return this.reason === "notListening"
      ? `${this.step} is not listening yet`
      : `${this.step}: its execve trace failed the check: ${this.detail}`;
  }
}

/**
 * Runs a script under strace and checks every execve.
 * @param step - The heading.
 * @param options - The script, environment, expected programs and secrets.
 * @returns Fails when the script fails or the trace has a problem.
 */
export const runTraced = Effect.fn("QuickstartCi.runTraced")(
  function* runTraced(
    step: string,
    options: Parameters<typeof traceScript>[0]
  ) {
    yield* Console.log(`\n### ${step}`);

    const traced = yield* traceScript(options);

    if (traced.code !== 0) {
      return yield* new QuickstartStepFailed({
        code: traced.code,
        detail: "",
        reason: "exited",
        step,
      });
    }

    if (traced.problems.length > 0) {
      return yield* new QuickstartStepFailed({
        code: null,
        detail: traced.problems.join("; "),
        reason: "trace",
        step,
      });
    }

    return yield* Console.log(
      `${step}: ${traced.calls} execve calls traced; no password or token in any argument`
    );
  }
);

/**
 * Runs a command in its own process group, with inherited output, and ends
 * the group when it exits (or when interrupted).
 * @param step - What it is, for the heading and errors.
 * @param command - The executable.
 * @param args - Its arguments.
 * @param env - Its environment.
 * @param cwd - Its working directory (default: this process's).
 * @returns Fails unless it exits 0.
 */
export const run = (
  step: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string
) =>
  Effect.scoped(
    Effect.gen(function* runStep() {
      yield* Console.log(`\n### ${step}`);

      const child = yield* spawnGroup(command, args, {
        cwd: cwd ?? process.cwd(),
        env,
        stdio: "inherit",
      });

      const code = yield* exitCode(child);

      if (code !== 0) {
        return yield* new QuickstartStepFailed({
          code,
          detail: "",
          reason: "exited",
          step,
        });
      }

      return code;
    })
  );

/** A running `std serve` and what it has logged so far. */
export interface Server {
  readonly exitCode: () => number | null;
  readonly log: () => string;
}

/**
 * Starts `std serve` in its own process group, ended when the scope closes.
 * Its log (one line per request) is kept, not printed, so the scripts'
 * output stays readable.
 * @param cli - The `std` command's entry module.
 * @param env - Its environment.
 * @returns The server.
 */
export const startServer = Effect.fn("QuickstartCi.startServer")(
  function* startServer(cli: string, env: NodeJS.ProcessEnv) {
    const chunks: string[] = [];

    const child = yield* spawnGroup(process.execPath, [cli, "serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const keep = (chunk: Uint8Array) => {
      chunks.push(String(chunk));
    };

    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    return {
      exitCode: () => child.exitCode,
      log: () => chunks.join(""),
    } satisfies Server;
  }
);

/**
 * Waits until the server logs the address it listens on.
 * @param server - The server.
 * @returns Its origin, such as `http://127.0.0.1:41234`.
 */
export const listeningAt = (server: Server) =>
  Effect.suspend(() => {
    const address = LISTENING.exec(server.log())?.groups?.url;

    if (address !== undefined) {
      return Effect.succeed(address);
    }

    const code = server.exitCode();

    return Effect.fail(
      new QuickstartStepFailed({
        code,
        detail: "",
        reason: code === null ? "notListening" : "exited",
        step: "std serve",
      })
    );
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(LISTEN_POLL_INTERVAL),
      times: LISTEN_POLLS,
      while: (failure) => failure.reason === "notListening",
    })
  );
