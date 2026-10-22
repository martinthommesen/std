/**
 * `party-foundation` from a real `v0.0.2` database (Contracts 11.6;
 * plan Step 3, workstream 3P; decision 0024): `v0.0.2`'s own `std upgrade`,
 * `std bootstrap-admin` and `std serve` make a database with 1,000 users;
 * this branch's `std upgrade` is killed (SIGKILL) inside the `data`
 * migration while users are created concurrently, servers refuse to start
 * and `doctor` reports it, a rerun completes it while more users are
 * created, and a second rerun changes nothing. Every user ends with
 * exactly one individual, the backfilled ones with change entries naming
 * the migration.
 *
 * The previous release comes from the release-compatibility machinery
 * (`src/release.ts`), so it needs the `v0.0.2` tag in the clone.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { TestDatabase, testDatabaseLayer } from "@std/testing/test-database";
import { Deferred, Effect, Fiber, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { PREVIOUS_RELEASE } from "../src/previous-release.ts";
import { cleanEnv, CURRENT, previousRelease, std } from "../src/release.ts";
import { listeningAt, run, startServer } from "../src/steps.ts";

/** Users of the old database, the system user and the administrator included. */
const OLD_USERS = 1000;

/** Users created while the migration runs, in each of two waves. */
const CONCURRENT_USERS = 6;

/** `std upgrade`'s batch size (`DATA_BATCH_SIZE`). */
const BATCH = 100;

/** The count of changed records in a ledger row's progress. */
const CHANGED = /"changed": (?<changed>\d+)/u;

const ADMIN_PASSWORD = `admin-${randomBytes(8).toString("hex")}`;

const decodeText = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ value: Schema.NullOr(Schema.String) }))
);

const TokenSchema = Schema.Struct({ token: Schema.String });
const decodeToken = Schema.decodeUnknownEffect(TokenSchema);

/**
 * The first column of a query's rows, as text.
 * @param text - The statement.
 * @param params - Its parameters.
 * @returns The values.
 */
const values = (text: string, params: readonly string[] = []) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(text, params)),
    Effect.flatMap(decodeText),
    Effect.map((rows) => rows.map((row) => row.value ?? "")),
    Effect.orDie
  );

const count = (text: string) =>
  values(text).pipe(Effect.map(([value]) => Number(value)));

/**
 * The environment of every command against the database.
 * @param url - The database.
 * @param login - The administrator `std bootstrap-admin` creates.
 * @returns The environment.
 */
const envFor = (url: string, login = "administrator"): NodeJS.ProcessEnv => ({
  ...cleanEnv(),
  STD_ADMIN_LOGIN: login,
  STD_ADMIN_PASSWORD: ADMIN_PASSWORD,
  STD_DATABASE_URL: url,
  STD_HTTP_HOST: "127.0.0.1",
  STD_HTTP_PORT: "0",
});

/** A request body: a sign-in or a user. */
type RequestBody = Readonly<Record<string, string | boolean>>;

/**
 * Sends a JSON request.
 * @param url - The URL.
 * @param body - The body.
 * @param token - A session token.
 * @returns The response's status and body.
 */
const post = (url: string, body: RequestBody, token?: string) =>
  Effect.promise(async () => {
    const headers = new Headers({ "content-type": "application/json" });

    if (token !== undefined) {
      headers.set("authorization", `Bearer ${token}`);
    }

    const response = await fetch(url, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    });

    return { json: await response.json(), status: response.status };
  });

/**
 * Fills the database with the release's own server: users created by its
 * administrator through its generic API.
 * @param cli - The release's `std` command.
 * @param env - The environment.
 * @param users - How many users to create.
 * @returns Succeeds once they exist.
 */
const createOldUsers = (cli: string, env: NodeJS.ProcessEnv, users: number) =>
  Effect.scoped(
    Effect.gen(function* oldUsers() {
      const server = yield* startServer(cli, env);
      const origin = yield* listeningAt(server);

      const signedIn = yield* post(`${origin}/api/v1/auth/sign-in`, {
        login: "administrator",
        password: ADMIN_PASSWORD,
      });

      const { token } = yield* decodeToken(signedIn.json).pipe(Effect.orDie);

      yield* Effect.all(
        Array.from({ length: users }, (_, index) =>
          post(
            `${origin}/api/v1/tables/core.user/records`,
            {
              active: true,
              login: `old-${index}`,
              name: `Old User ${index}`,
            },
            token
          ).pipe(
            Effect.flatMap((created) =>
              created.status === 201
                ? Effect.void
                : Effect.die(new Error(`user ${index}: ${created.status}`))
            )
          )
        ),
        { concurrency: 16 }
      );
    })
  );

/**
 * Users created concurrently, each by its own `std bootstrap-admin` of
 * this branch.
 * @param url - The database.
 * @param wave - Which wave, for the logins.
 * @returns Succeeds once every command exited 0.
 */
const concurrentUsers = (url: string, wave: string) =>
  Effect.all(
    Array.from({ length: CONCURRENT_USERS }, (_, index) =>
      std(CURRENT, "bootstrap-admin", envFor(url, `${wave}-${index}`))
    ),
    { concurrency: CONCURRENT_USERS }
  );

/**
 * Starts this branch's `std upgrade`; the scope kills it with SIGKILL and
 * waits for it to exit.
 * @param url - The database.
 * @returns The process.
 */
const startUpgrade = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [CURRENT.cli, "upgrade"], {
        env: envFor(url),
        stdio: "ignore",
      })
    ),
    (child: ChildProcess) =>
      Effect.callback<boolean>((resume) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resume(Effect.succeed(true));

          return;
        }

        child.once("exit", () => {
          resume(Effect.succeed(true));
        });
        child.kill("SIGKILL");
      }).pipe(Effect.asVoid)
  );

/**
 * Starts this branch's `std serve`, which must refuse to start.
 * @param env - The environment.
 * @returns Why it is not listening, and its log.
 */
const refusedServe = (env: NodeJS.ProcessEnv) =>
  Effect.scoped(
    Effect.gen(function* serveRefusing() {
      const server = yield* startServer(CURRENT.cli, env);
      const failure = yield* listeningAt(server).pipe(Effect.flip);

      return { failure, log: server.log() };
    })
  );

/**
 * Polls until a condition holds.
 * @param check - The condition.
 * @returns Succeeds once it holds; dies after 60 s.
 */
const waitUntil = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("50 millis"),
      until: (done) => done,
    }),
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.die(new Error("waitUntil timed out")),
    })
  );

const ledger = values(
  // Through to_jsonb: before migration 0011 runs the ledger has no state.
  "SELECT (to_jsonb(m) ->> 'state') || ' ' || COALESCE(to_jsonb(m) ->> 'progress', '') AS value FROM core.platform_migration AS m WHERE id = 12"
).pipe(Effect.map(([row]) => row ?? ""));

const cliGone = count(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = 'std-cli'`
).pipe(Effect.map((connected) => connected === 0));

/** Users, users with an individual, distinct individuals, individuals. */
const partyCounts = values(
  `SELECT concat_ws(' ',
     (SELECT count(*) FROM core."user"),
     (SELECT count(individual) FROM core."user"),
     (SELECT count(DISTINCT individual) FROM core."user"),
     (SELECT count(*) FROM core.individual)) AS value`
).pipe(Effect.map(([row]) => (row ?? "").split(" ").map(Number)));

const backfillEntries = count(
  `SELECT count(*)::text AS value FROM core.change
   WHERE cause = '{"kind": "system", "migration": {"id": 12, "name": "user-individuals"}}'::jsonb`
);

const changes = count("SELECT count(*)::text AS value FROM core.change");

describe("party-foundation", () => {
  it(`upgrades from ${PREVIOUS_RELEASE}, the release before the party foundation`, () => {
    assert.strictEqual(PREVIOUS_RELEASE, "v0.0.2");
  });

  layer(testDatabaseLayer({ empty: true }), {
    excludeTestServices: true,
    timeout: 300_000,
  })((dbTest) => {
    dbTest.effect(
      "an upgrade from v0.0.2 with 1,000 users, killed in the data migration and rerun while users are created, gives every user exactly one individual",
      () =>
        Effect.scoped(
          Effect.gen(function* upgradeFromRelease() {
            const database = yield* TestDatabase;
            const env = envFor(database.url);
            const release = yield* previousRelease;

            // The release's own database: its upgrade, administrator and
            // 998 more users through its own server.
            yield* std(release, "upgrade", env);
            yield* std(release, "bootstrap-admin", env);
            yield* createOldUsers(release.cli, env, OLD_USERS - 2);
            assert.strictEqual(
              yield* count(`SELECT count(*)::text AS value FROM core."user"`),
              OLD_USERS
            );

            // This branch's upgrade, stopped (SIGSTOP) once a batch of the
            // data migration committed, then killed (SIGKILL): mid-migration.
            const started = yield* Deferred.make<ChildProcess>();

            const upgrade = yield* Effect.forkChild(
              Effect.scoped(
                startUpgrade(database.url).pipe(
                  Effect.flatMap((child) => Deferred.succeed(started, child)),
                  Effect.andThen(Effect.never)
                )
              )
            );

            const child = yield* Deferred.await(started);

            yield* waitUntil(
              ledger.pipe(Effect.map((row) => row.startsWith("running {")))
            );
            child.kill("SIGSTOP");

            // Users created while the data migration is under way.
            yield* concurrentUsers(database.url, "during-run");

            yield* Fiber.interrupt(upgrade);
            yield* waitUntil(cliGone);

            const stopped = yield* ledger;
            const done = Number(CHANGED.exec(stopped)?.groups?.changed);

            assert.isTrue(stopped.startsWith("running "), stopped);
            assert.isAtLeast(done, BATCH);
            assert.isBelow(done, OLD_USERS);
            // Every committed batch's records, none of the killed one's.
            assert.deepStrictEqual(yield* partyCounts, [
              OLD_USERS + CONCURRENT_USERS,
              done + CONCURRENT_USERS,
              done + CONCURRENT_USERS,
              done + CONCURRENT_USERS,
            ]);

            // Servers refuse to start; doctor reports the migration.
            const serve = yield* refusedServe(env);

            assert.strictEqual(serve.failure.reason, "exited", serve.log);
            assert.include(
              serve.log,
              "incomplete data migration 12 (user-individuals)"
            );

            const doctor = yield* std(CURRENT, "doctor", env).pipe(Effect.flip);

            assert.strictEqual(doctor.code, 1);

            // The rerun completes it while more users are created.
            const more = yield* Effect.forkChild(
              concurrentUsers(database.url, "during-rerun")
            );

            yield* std(CURRENT, "upgrade", env);
            yield* Fiber.join(more);
            yield* std(CURRENT, "doctor", env);

            const total = OLD_USERS + 2 * CONCURRENT_USERS;

            assert.deepStrictEqual(yield* partyCounts, [
              total,
              total,
              total,
              total,
            ]);
            assert.include(yield* ledger, `applied {"changed": ${OLD_USERS}}`);
            // An individual's create and the user's update, per old user.
            assert.strictEqual(yield* backfillEntries, 2 * OLD_USERS);

            // A second rerun changes nothing.
            const before = yield* changes;

            yield* std(CURRENT, "upgrade", env);
            assert.strictEqual(yield* changes, before);
            yield* run(
              "std doctor (this branch, after the second rerun)",
              process.execPath,
              [CURRENT.cli, "doctor"],
              env
            );
          })
        ),
      300_000
    );
  });
});
