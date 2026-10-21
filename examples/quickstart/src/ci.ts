/**
 * `pnpm quickstart:ci`: runs `examples/quickstart.sh` the way the compose
 * file does, without Docker, so the quickstart cannot rot (CI step
 * "Quickstart").
 *
 * On a disposable empty database from `@std/testing`'s harness (dropped at
 * the end, or by the harness's janitor if this process is killed), it runs
 * `std upgrade` and `std bootstrap-admin`, starts `std serve` on a port the
 * system picks, waits until it listens, and runs the quickstart twice: the
 * second run proves a rerun against the same database succeeds. Each run
 * ends with `std doctor`, and any nonzero exit fails this command. The
 * server's log is printed only when a step fails.
 *
 * Needs the Postgres at `STD_DATABASE_URL` (as every test does), bash, curl
 * and jq.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { NodeRuntime } from "@effect/platform-node";
import { TestDatabase, testDatabaseService } from "@std/testing/test-database";
import { Console, Effect, Schedule, Schema } from "effect";

const CLI = fileURLToPath(
  new URL("../../../packages/server/src/cli/main.ts", import.meta.url)
);

const SCRIPT = fileURLToPath(new URL("../../quickstart.sh", import.meta.url));

/** Disposable credentials of the administrator the quickstart signs in as. */
const ADMIN = { login: "admin", password: "quickstart-ci-admin-password" };

/** How long `std serve` may take to listen: 150 polls, 200 ms apart. */
const LISTEN_POLLS = 150;
const LISTEN_POLL_INTERVAL = "200 millis";

/** The line `std serve` logs once it listens (Effect's Node HTTP server). */
const LISTENING = /Listening on (?<url>http:\/\/[\d.:]+)/u;

/** A step of the run failed: it exited nonzero, or the server never listened. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class QuickstartStepFailed extends Schema.TaggedError<
  QuickstartStepFailed,
  { readonly brand: unique symbol }
>()("QuickstartStepFailed", {
  code: Schema.NullOr(Schema.Number),
  reason: Schema.Literals(["exited", "notListening"]),
  step: Schema.String,
}) {
  /**
   * Names the step and what went wrong.
   * @returns The message.
   */
  override get message(): string {
    return this.reason === "exited"
      ? `${this.step} exited with ${String(this.code)}`
      : `${this.step} is not listening yet`;
  }
}

/**
 * Runs a command to completion with inherited output.
 * @param step - What it is, for the heading and errors.
 * @param command - The executable.
 * @param args - Its arguments.
 * @param env - Its environment.
 * @returns Fails unless it exits 0.
 */
const run = (
  step: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
) =>
  Console.log(`\n### ${step}`).pipe(
    Effect.andThen(
      Effect.callback<number | null>((resume) => {
        const child = spawn(command, args, { env, stdio: "inherit" });

        child.once("error", (error) => {
          resume(Effect.die(error));
        });
        child.once("close", (code) => {
          resume(Effect.succeed(code));
        });

        return Effect.sync(() => {
          child.kill("SIGKILL");
        });
      })
    ),
    Effect.flatMap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new QuickstartStepFailed({ code, reason: "exited", step })
          )
    )
  );

const stop = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
    child.kill("SIGTERM");
  }).pipe(Effect.asVoid);

/** A running `std serve` and what it has logged so far. */
interface Server {
  readonly child: ChildProcess;
  readonly log: () => string;
}

/**
 * Starts `std serve`; it is stopped when the scope closes. Its log (one
 * line per request) is kept, not printed, so the quickstart's output stays
 * readable.
 * @param env - Its environment.
 * @returns The server.
 */
const startServer = (env: NodeJS.ProcessEnv) =>
  Effect.acquireRelease(
    Effect.sync((): Server => {
      const chunks: string[] = [];

      const child = spawn(process.execPath, [CLI, "serve"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const keep = (chunk: Uint8Array) => {
        chunks.push(String(chunk));
      };

      child.stdout.on("data", keep);
      child.stderr.on("data", keep);

      return { child, log: () => chunks.join("") };
    }),
    (server) => stop(server.child)
  );

/**
 * Waits until the server logs the address it listens on.
 * @param server - The server.
 * @returns Its origin, such as `http://127.0.0.1:41234`.
 */
const listeningAt = (server: Server) =>
  Effect.suspend(() => {
    const address = LISTENING.exec(server.log())?.groups?.url;

    if (address !== undefined) {
      return Effect.succeed(address);
    }

    const reason = server.child.exitCode === null ? "notListening" : "exited";

    return Effect.fail(
      new QuickstartStepFailed({
        code: server.child.exitCode,
        reason,
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

const quickstart = Effect.gen(function* runQuickstart() {
  const database = yield* TestDatabase;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STD_ADMIN_LOGIN: ADMIN.login,
    STD_ADMIN_PASSWORD: ADMIN.password,
    STD_DATABASE_URL: database.url,
    STD_DOCTOR_COMMAND: `"${process.execPath}" "${CLI}" doctor`,
    STD_HTTP_HOST: "127.0.0.1",
    STD_HTTP_PORT: "0",
  };

  yield* Console.log(`Quickstart on the disposable database ${database.name}`);
  yield* run("std upgrade", process.execPath, [CLI, "upgrade"], env);
  yield* run(
    "std bootstrap-admin",
    process.execPath,
    [CLI, "bootstrap-admin"],
    env
  );

  const server = yield* startServer(env);

  yield* Effect.gen(function* runWithServer() {
    const url = yield* listeningAt(server);

    yield* run("examples/quickstart.sh (first run)", "bash", [SCRIPT], {
      ...env,
      QUICKSTART_RUN: "ci-1",
      STD_URL: url,
    });
    yield* run(
      "examples/quickstart.sh (second run, same database)",
      "bash",
      [SCRIPT],
      { ...env, QUICKSTART_RUN: "ci-2", STD_URL: url }
    );
  }).pipe(
    Effect.tapError(() => Console.error(`\n### std serve log\n${server.log()}`))
  );
  yield* Console.log("\nquickstart:ci: both runs exited 0");
});

NodeRuntime.runMain(
  quickstart.pipe(
    Effect.scoped,
    Effect.provide(testDatabaseService({ empty: true }))
  ),
  { disableErrorReporting: false }
);
