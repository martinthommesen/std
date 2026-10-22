/**
 * `pnpm release-compat:ci`: the previous release's databases and clients
 * keep working with this branch (CI step "Release compatibility").
 *
 * 1. The tree of the previous release's tag (`previous-release.ts`) is
 *    extracted with `git archive` into a temporary directory (without the
 *    vendored `repos/`) and installed there.
 * 2. Upgrade path, on a disposable empty database: that release's own
 *    `std upgrade`, `std bootstrap-admin`, `std serve` and its own
 *    `examples/quickstart.sh`; then this branch's `std upgrade` on the same
 *    database, `std doctor` (must exit 0), this branch's `std serve`, the
 *    release's quickstart again, unchanged, and this branch's quickstart.
 * 3. Old clients, on a second empty database: this branch's `std upgrade`,
 *    `std bootstrap-admin` and `std serve`, then the release's quickstart
 *    on its first run, so its change sets, user and record requests all
 *    reach this branch's API in the release's wire format.
 *
 * Each quickstart run ends with `std doctor` of the server it runs against.
 * The databases are dropped and the directory removed at the end. Needs
 * git with the release tag (CI checks out with tags), bash, curl, jq and
 * the Postgres at `STD_DATABASE_URL`.
 */
import { randomBytes } from "node:crypto";

import { NodeRuntime } from "@effect/platform-node";
import { TestDatabase, testDatabaseService } from "@std/testing/test-database";
import { Console, Effect } from "effect";

import { PREVIOUS_RELEASE } from "./previous-release.ts";
import { cleanEnv, CURRENT, previousRelease, std } from "./release.ts";
import type { Release } from "./release.ts";
import { listeningAt, run, startServer } from "./steps.ts";

/**
 * A disposable password, fresh for every run.
 * @param who - Whose it is.
 * @returns The password.
 */
const secret = (who: string): string =>
  `${who}-compat-${randomBytes(8).toString("hex")}`;

const PASSWORDS = {
  admin: secret("administrator"),
  alice: secret("alice"),
  bob: secret("bob"),
};

/**
 * The environment of every command against one database.
 * @param url - The database.
 * @returns The environment.
 */
const databaseEnv = (url: string): NodeJS.ProcessEnv => ({
  ...cleanEnv(),
  QUICKSTART_ALICE_PASSWORD: PASSWORDS.alice,
  QUICKSTART_BOB_PASSWORD: PASSWORDS.bob,
  STD_ADMIN_LOGIN: "administrator",
  STD_ADMIN_PASSWORD: PASSWORDS.admin,
  STD_DATABASE_URL: url,
  STD_HTTP_HOST: "127.0.0.1",
  STD_HTTP_PORT: "0",
});

/**
 * Starts a release's `std serve` and runs quickstart scripts against it,
 * each ending with that release's `std doctor`.
 * @param server - Whose server.
 * @param scripts - The scripts and their run tags, in order.
 * @param env - The environment.
 * @returns Fails when a script fails.
 */
const serveAndRun = (
  server: Release,
  scripts: readonly (readonly [Release, string])[],
  env: NodeJS.ProcessEnv
) =>
  Effect.scoped(
    Effect.gen(function* serveAndRunScripts() {
      const running = yield* startServer(server.cli, env);

      yield* Effect.gen(function* runScripts() {
        const url = yield* listeningAt(running);

        for (const [script, tag] of scripts) {
          yield* run(
            `${script.name}'s examples/quickstart.sh against ${server.name}'s std serve (${tag})`,
            "bash",
            [script.script],
            {
              ...env,
              QUICKSTART_RUN: tag,
              STD_DOCTOR_COMMAND: `"${process.execPath}" "${server.cli}" doctor`,
              STD_URL: url,
            }
          );
        }
      }).pipe(
        Effect.tapError(() =>
          Console.error(
            `\n### ${server.name}'s std serve log\n${running.log()}`
          )
        )
      );
    })
  );

/**
 * The upgrade path: the release installs and fills a database, then this
 * branch upgrades it and serves both quickstarts.
 * @param release - The previous release.
 * @returns Fails at the first failing step.
 */
const upgradePath = (release: Release) =>
  Effect.gen(function* upgradeThenServe() {
    const database = yield* TestDatabase;
    const env = databaseEnv(database.url);

    yield* Console.log(
      `\n## Upgrade path: ${release.name} then this branch, on ${database.name}`
    );
    yield* std(release, "upgrade", env);
    yield* std(release, "bootstrap-admin", env);
    yield* serveAndRun(release, [[release, "compat-1"]], env);
    yield* std(CURRENT, "upgrade", env);
    yield* std(CURRENT, "doctor", env);
    yield* serveAndRun(
      CURRENT,
      [
        [release, "compat-2"],
        [CURRENT, "compat-3"],
      ],
      env
    );
  }).pipe(Effect.provide(testDatabaseService({ empty: true })));

/**
 * Old clients: the release's quickstart creates everything through this
 * branch's API on a fresh install.
 * @param release - The previous release.
 * @returns Fails at the first failing step.
 */
const oldClients = (release: Release) =>
  Effect.gen(function* releaseQuickstartOnFreshInstall() {
    const database = yield* TestDatabase;
    const env = databaseEnv(database.url);

    yield* Console.log(
      `\n## Old clients: ${release.name}'s quickstart on a fresh install of this branch, on ${database.name}`
    );
    yield* std(CURRENT, "upgrade", env);
    yield* std(CURRENT, "bootstrap-admin", env);
    yield* serveAndRun(CURRENT, [[release, "compat-4"]], env);
  }).pipe(Effect.provide(testDatabaseService({ empty: true })));

const releaseCompat = Effect.gen(function* releaseCompat() {
  const release = yield* previousRelease;

  yield* upgradePath(release);
  yield* oldClients(release);

  return yield* Console.log(
    `\nrelease-compat:ci: ${PREVIOUS_RELEASE} upgrades to this branch, and its quickstart runs against it`
  );
});

NodeRuntime.runMain(releaseCompat.pipe(Effect.scoped), {
  disableErrorReporting: false,
});
