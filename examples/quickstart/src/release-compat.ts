/**
 * `pnpm release-compat:ci`: the previous release's databases upgrade to
 * this branch (CI step "Release compatibility", a database-upgrade check;
 * decision 0021, decision 56: clients of the old API are not supported).
 *
 * 1. The tree of the previous release's tag (`previous-release.ts`) is
 *    extracted with `git archive` into a temporary directory (without the
 *    vendored `repos/`) and installed there.
 * 2. On a disposable empty database, the release builds a database the way
 *    it was used: its own `std upgrade`, `std bootstrap-admin`, `std serve`
 *    and its own `examples/quickstart.sh` (definitions, roles, rules,
 *    users and records through its own API).
 * 3. This branch's `std upgrade` upgrades that database, `std doctor` must
 *    exit 0, and this branch's `std serve` serves this branch's quickstart
 *    against it, which finds and reuses what the release created.
 *
 * Each quickstart run ends with `std doctor` of the server it runs against.
 * The database is dropped and the directory removed at the end. Needs git
 * with the release tag (CI checks out with tags), bash, curl, jq and the
 * Postgres at `STD_DATABASE_URL`.
 */
import { randomBytes } from "node:crypto";

import { NodeRuntime } from "@effect/platform-node";
import { TestDatabase, testDatabaseService } from "@std/testing/test-database";
import { Console, Effect } from "effect";

import { PREVIOUS_RELEASE } from "./previous-release.ts";
import { cleanEnv, CURRENT, extractRelease, std } from "./release.ts";
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
  STD_DATABASE_DIRECT_URL: url,
  STD_DATABASE_URL: url,
  STD_HTTP_HOST: "127.0.0.1",
  STD_HTTP_PORT: "0",
});

/**
 * Starts a release's `std serve` and runs its quickstart script against it,
 * ending with that release's `std doctor`.
 * @param release - Whose server and script.
 * @param tag - The script's run tag.
 * @param env - The environment.
 * @returns Fails when a script fails.
 */
const serveAndRun = (release: Release, tag: string, env: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* serveAndRunScripts() {
      const running = yield* startServer(release.cli, env);

      yield* Effect.gen(function* runScripts() {
        const url = yield* listeningAt(running);

        yield* run(
          `${release.name}'s examples/quickstart.sh against ${release.name}'s std serve (${tag})`,
          "bash",
          [release.script],
          {
            ...env,
            QUICKSTART_RUN: tag,
            STD_DOCTOR_COMMAND: `"${process.execPath}" "${release.cli}" doctor`,
            STD_URL: url,
          }
        );
      }).pipe(
        Effect.tapError(() =>
          Console.error(
            `\n### ${release.name}'s std serve log\n${running.log()}`
          )
        )
      );
    })
  );

/**
 * The upgrade check: the release installs and fills a database, then this
 * branch upgrades it and serves its own quickstart.
 * @param release - The previous release.
 * @returns Fails at the first failing step.
 */
const upgradePath = (release: Release) =>
  Effect.gen(function* upgradeThenServe() {
    const database = yield* TestDatabase;
    const env = databaseEnv(database.url);

    yield* Console.log(
      `\n## Database upgrade: ${release.name} builds it, this branch upgrades it, on ${database.name}`
    );
    yield* std(release, "upgrade", env);
    yield* std(release, "bootstrap-admin", env);
    yield* serveAndRun(release, "compat-1", env);
    yield* std(CURRENT, "upgrade", env);
    yield* std(CURRENT, "doctor", env);
    yield* serveAndRun(CURRENT, "compat-2", env);
  }).pipe(Effect.provide(testDatabaseService({ empty: true })));

const releaseCompat = Effect.gen(function* releaseCompat() {
  const release = yield* extractRelease(PREVIOUS_RELEASE);

  yield* upgradePath(release);

  return yield* Console.log(
    `\nrelease-compat:ci: a ${PREVIOUS_RELEASE} database upgrades to this branch, and this branch's quickstart runs against it`
  );
});

NodeRuntime.runMain(releaseCompat.pipe(Effect.scoped), {
  disableErrorReporting: false,
});
