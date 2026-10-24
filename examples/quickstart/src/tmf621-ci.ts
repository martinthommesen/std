/**
 * `pnpm tmf621-example:ci`: runs `examples/helpdesk/tmf621.sh` against a
 * real `std serve` so the TMF621 example cannot rot (CI step "TMF621
 * example").
 *
 * On a disposable empty database from `@std/testing`'s harness it runs
 * `std upgrade --set examples/helpdesk/v4` and `std bootstrap-admin` (a
 * random login and password), starts `std serve` on a port the system
 * picks, a production worker and the local listener, and runs the script twice
 * (the rerun must succeed too). Each run verifies callback receipts and a replay
 * deduplicated by eventId. Server/worker logs are printed only on failure.
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
import { startListener } from "@std/example-listener/listener";
import { testDatabaseService } from "@std/testing/test-database";
import { Console, Effect } from "effect";

import { findStrace, program } from "./exec-trace.ts";
import type { ExpectedProgram } from "./exec-trace.ts";
import { CLI, startHelpdeskServer } from "./helpdesk-server.ts";
import { spawnGroup } from "./process-group.ts";
import { runTraced } from "./steps.ts";

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

const tmf621 = Effect.gen(function* runTmf621() {
  // Before anything else: without strace the credential check cannot run.
  yield* findStrace();

  const listener = yield* startListener(0);

  const server = yield* startHelpdeskServer(ADMIN, {
    STD_HUB_ALLOW_PRIVATE_ADDRESSES: "true",
  });

  const worker = yield* spawnGroup(process.execPath, [CLI, "worker"], {
    env: server.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const workerLog: string[] = [];
  worker.stdout?.on("data", (chunk: Uint8Array) => {
    workerLog.push(String(chunk));
  });
  worker.stderr?.on("data", (chunk: Uint8Array) => {
    workerLog.push(String(chunk));
  });

  yield* Effect.gen(function* runWithServer() {
    const env = {
      ...process.env,
      STD_URL: server.url,
      TMF621_LISTENER: listener,
      TMF621_LOGIN: ADMIN.login,
      TMF621_PASSWORD: ADMIN.password,
    };

    yield* runTraced("examples/helpdesk/tmf621.sh (first run)", {
      env: { ...env, TMF621_RUN: "ci-1" },
      expected: EXPECTED,
      script: SCRIPT,
      secrets: [ADMIN.password],
    });

    return yield* runTraced(
      "examples/helpdesk/tmf621.sh (second run, same database)",
      {
        env: { ...env, TMF621_RUN: "ci-2" },
        expected: EXPECTED,
        script: SCRIPT,
        secrets: [ADMIN.password],
      }
    );
  }).pipe(
    Effect.tapError(() =>
      Console.error(
        `\n### std serve log\n${server.log()}\n### std worker log\n${workerLog.join("")}`
      )
    )
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
