/**
 * `pnpm quickstart:ci`: runs `examples/quickstart.sh` the way the compose
 * file does, without Docker, so the quickstart cannot rot (CI step
 * "Quickstart").
 *
 * On a disposable empty database from `@std/testing`'s harness (dropped at
 * the end, or by the harness's janitor if this process is killed), it runs
 * `std upgrade` and `std bootstrap-admin`, starts `std serve` on a port the
 * system picks, waits until it listens, and runs the quickstart twice. The
 * second run proves a rerun converges, also from a partial setup: before
 * it, Alice's role assignment is deleted, as if the first run had stopped
 * between creating her and assigning her role. Each run ends with
 * `std doctor`, and any nonzero exit fails this command. The server's log
 * is printed only when a step fails.
 *
 * Credentials: each script run runs under
 * `strace -f -e trace=execve,execveat` (`exec-trace.ts`), which records
 * every program the script and its descendants start, whatever started
 * them. The run fails if any argument or program path holds one of the
 * run's random passwords or a session token, if any call failed, if the
 * trace has a line or call it cannot read, or if it lacks curl, jq or the
 * doctor command. This guards against accidental regressions in the
 * script, not a deliberately adversarial one, and covers only the script's
 * descendants (decision 0016, "Threat model").
 *
 * Every command runs in its own process group, ended and awaited when its
 * step ends, also on interruption (`process-group.ts`): a SIGTERM to this
 * command leaves no curl, jq, doctor or server process behind, and the
 * database is dropped only after they are gone.
 *
 * Needs Linux, the Postgres at `STD_DATABASE_URL` (as every test does),
 * bash, curl, jq and strace; without strace it fails and says how to
 * install it.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { NodeRuntime } from "@effect/platform-node";
import { authenticationClient, makeStdClient } from "@std/api/client";
import { TestDatabase, testDatabaseService } from "@std/testing/test-database";
import { Console, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { findStrace, program, traceScript } from "./exec-trace.ts";
import type { ExpectedProgram } from "./exec-trace.ts";
import {
  listeningAt,
  QuickstartStepFailed,
  run,
  startServer,
} from "./steps.ts";

const CLI = fileURLToPath(
  new URL("../../../packages/server/src/cli/main.ts", import.meta.url)
);

const SCRIPT = fileURLToPath(new URL("../../quickstart.sh", import.meta.url));

/**
 * A disposable password, fresh for every CI run.
 * @param who - Whose it is.
 * @returns The password.
 */
const secret = (who: string): string =>
  `${who}-ci-${randomBytes(8).toString("hex")}`;

const PASSWORDS = {
  admin: secret("administrator"),
  alice: secret("alice"),
  bob: secret("bob"),
};

const ADMIN_LOGIN = "administrator";

/** Fetch without keep-alive, so nothing holds the server open. */
const Fetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })
  )
);

/**
 * Deletes Alice's role assignments as the administrator, through the typed
 * client: the state a first run leaves when it stops between creating her
 * and assigning her role. The next run must restore it.
 * @param baseUrl - The server's origin.
 * @returns How many assignments were deleted.
 */
const dropAliceRoles = Effect.fn("QuickstartCi.dropAliceRoles")(
  function* dropAliceRoles(baseUrl: string) {
    yield* Console.log(
      "\n### A partial setup: delete Alice's role assignment before the rerun"
    );

    const anonymous = yield* makeStdClient({ baseUrl }).pipe(
      Effect.provide(authenticationClient())
    );

    const session = yield* anonymous.signIn.signIn({
      payload: { login: ADMIN_LOGIN, password: PASSWORDS.admin },
    });

    const admin = yield* makeStdClient({ baseUrl }).pipe(
      Effect.provide(authenticationClient(Redacted.make(session.token)))
    );

    const users = yield* admin.records.list({
      params: { table: "core.user" },
      query: { filter: 'login = "alice"' },
    });

    const alice = users.records[0]?.id ?? "";

    const assignments = yield* admin.records.list({
      params: { table: "core.user_role" },
      query: { filter: `user = "${alice}"` },
    });

    for (const assignment of assignments.records) {
      yield* admin.records.remove({
        headers: { "if-match": `"${assignment.version}"` },
        params: { id: assignment.id, table: "core.user_role" },
      });
    }

    yield* Console.log(
      `deleted ${assignments.records.length} role assignment(s) of alice`
    );

    return assignments.records.length;
  },
  Effect.provide(Fetch)
);

/** What every script run must have started. */
const EXPECTED: readonly ExpectedProgram[] = [
  program("curl"),
  program("jq"),
  {
    name: "the doctor command",
    ran: (call) => call.argv.includes(CLI) && call.argv.at(-1) === "doctor",
  },
];

/**
 * Runs the quickstart script under strace and checks every execve.
 * @param step - The heading.
 * @param env - Its environment.
 * @returns Fails when the script fails or the trace has a problem.
 */
const runTraced = Effect.fn("QuickstartCi.runTraced")(function* runTraced(
  step: string,
  env: NodeJS.ProcessEnv
) {
  yield* Console.log(`\n### ${step}`);

  const traced = yield* traceScript({
    env,
    expected: EXPECTED,
    script: SCRIPT,
    secrets: Object.values(PASSWORDS),
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

const quickstart = Effect.gen(function* runQuickstart() {
  // Before anything else: without strace the credential check cannot run.
  yield* findStrace();

  const database = yield* TestDatabase;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUICKSTART_ALICE_PASSWORD: PASSWORDS.alice,
    QUICKSTART_BOB_PASSWORD: PASSWORDS.bob,
    STD_ADMIN_LOGIN: ADMIN_LOGIN,
    STD_ADMIN_PASSWORD: PASSWORDS.admin,
    STD_DATABASE_DIRECT_URL: database.url,
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

  const server = yield* startServer(CLI, env);

  yield* Effect.gen(function* runWithServer() {
    const url = yield* listeningAt(server);
    const scriptEnv = { ...env, STD_URL: url };

    yield* runTraced("examples/quickstart.sh (first run)", {
      ...scriptEnv,
      QUICKSTART_RUN: "ci-1",
    });

    const dropped = yield* dropAliceRoles(url);

    if (dropped === 0) {
      return yield* Effect.die(
        new Error("the first run left Alice without a role assignment")
      );
    }

    return yield* runTraced(
      "examples/quickstart.sh (second run, same database, after a partial setup)",
      { ...scriptEnv, QUICKSTART_RUN: "ci-2" }
    );
  }).pipe(
    Effect.tapError(() => Console.error(`\n### std serve log\n${server.log()}`))
  );

  return yield* Console.log("\nquickstart:ci: both runs exited 0");
});

NodeRuntime.runMain(
  quickstart.pipe(
    Effect.scoped,
    Effect.provide(testDatabaseService({ empty: true }))
  ),
  { disableErrorReporting: false }
);
