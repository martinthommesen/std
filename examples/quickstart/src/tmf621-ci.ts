/**
 * `pnpm tmf621-example:ci`: runs `examples/helpdesk/tmf621.sh` against a
 * real `std serve` so the TMF621 example cannot rot (CI step "TMF621
 * example").
 *
 * On a disposable empty database from `@std/testing`'s harness it runs
 * `std upgrade --set examples/helpdesk/v3` and `std bootstrap-admin` (a
 * random login and password), starts `std serve` on a port the system
 * picks, and runs the script twice (the rerun must succeed too). The
 * server's log is printed only when a step fails.
 *
 * Credentials: each script run runs under `strace -f -e trace=execve,execveat`
 * as in `pnpm quickstart:ci` (`exec-trace.ts`): the run fails if any
 * argument or program path holds the run's random password or a session
 * token, or if the trace lacks curl or jq.
 *
 * Needs Linux, the Postgres at `STD_DATABASE_URL`, bash, curl, jq and
 * strace.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { NodeRuntime } from "@effect/platform-node";
import { testDatabaseService } from "@std/testing/test-database";
import { Console, Effect } from "effect";

import { findStrace, program, traceScript } from "./exec-trace.ts";
import type { ExpectedProgram } from "./exec-trace.ts";
import { startHelpdeskServer } from "./helpdesk-server.ts";
import { QuickstartStepFailed } from "./steps.ts";

const SCRIPT = fileURLToPath(
  new URL("../../helpdesk/tmf621.sh", import.meta.url)
);

/** Random bytes in the disposable login and password. */
const SECRET_BYTES = 8;

const ADMIN = {
  login: `tmf621-${randomBytes(SECRET_BYTES).toString("hex")}`,
  password: `tmf621-ci-${randomBytes(SECRET_BYTES).toString("hex")}`,
};

/** What every script run must have started. */
const EXPECTED: readonly ExpectedProgram[] = [program("curl"), program("jq")];

/**
 * Runs the example script under strace and checks every execve.
 * @param step - The heading.
 * @param env - Its environment.
 * @returns Fails when the script fails or the trace has a problem.
 */
const runTraced = Effect.fn("Tmf621Ci.runTraced")(function* runTraced(
  step: string,
  env: NodeJS.ProcessEnv
) {
  yield* Console.log(`\n### ${step}`);

  const traced = yield* traceScript({
    env,
    expected: EXPECTED,
    script: SCRIPT,
    secrets: [ADMIN.password],
  });

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
});

const tmf621 = Effect.gen(function* runTmf621() {
  // Before anything else: without strace the credential check cannot run.
  yield* findStrace();

  const server = yield* startHelpdeskServer(ADMIN);

  yield* Effect.gen(function* runWithServer() {
    const env = {
      ...process.env,
      STD_URL: server.url,
      TMF621_LOGIN: ADMIN.login,
      TMF621_PASSWORD: ADMIN.password,
    };

    yield* runTraced("examples/helpdesk/tmf621.sh (first run)", {
      ...env,
      TMF621_RUN: "ci-1",
    });

    return yield* runTraced(
      "examples/helpdesk/tmf621.sh (second run, same database)",
      { ...env, TMF621_RUN: "ci-2" }
    );
  }).pipe(
    Effect.tapError(() => Console.error(`\n### std serve log\n${server.log()}`))
  );

  return yield* Console.log("\ntmf621-example:ci: both runs exited 0");
});

NodeRuntime.runMain(
  tmf621.pipe(
    Effect.scoped,
    Effect.provide(testDatabaseService({ empty: true }))
  ),
  { disableErrorReporting: false }
);
