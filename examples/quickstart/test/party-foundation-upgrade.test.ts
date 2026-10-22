/**
 * `party-foundation` from a real `v0.0.2` database (Contracts 11.6;
 * plan Step 3, workstream 3P; decision 0024): `v0.0.2`'s own `std upgrade`,
 * `std bootstrap-admin` and `std serve` make a database with 1,000 users;
 * this branch's `std upgrade` is killed (SIGKILL) inside the `data`
 * migration, while it waits at a barrier the test holds in its eighth
 * batch and users are created concurrently; servers refuse to start
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
import { Transactions } from "@std/server/sql/transactions";
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

/** The batch the run is stopped in (0-based): seven batches commit first. */
const BARRIER_BATCH = 7;

/** `core.change`'s platform class and `core.user`, by stable ID. */
const CHANGE_CLASS_ID = "edde151d-f204-4639-bcbf-a4793f86a219";
const USER_CLASS_ID = "da385db7-b2b7-4a1d-a1a9-42e8e0bb7992";
const SYSTEM_USER_ID = "1970f1d9-a830-4414-ba8e-210e07952a85";

/** A change entry for version 2 of the user `$1`, the backfill's key. */
const BARRIER_ENTRY = `INSERT INTO core."change" (id, class_id, version, created_at, created_by, updated_at, updated_by,
    operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
  VALUES (uuidv7(), '${CHANGE_CLASS_ID}', 1, now(), '${SYSTEM_USER_ID}', now(), '${SYSTEM_USER_ID}',
    uuidv7(), $1::uuid, '${USER_CLASS_ID}', 2, 'update', '${SYSTEM_USER_ID}', '{"kind": "system"}', 0, now(), '{}')`;

/** Ends the barrier transaction with a rollback. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class BarrierReleased extends Schema.TaggedError<
  BarrierReleased,
  { readonly brand: unique symbol }
>()("BarrierReleased", {}) {}

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
 * The database URL for the upgrade the test kills: no lock timeout, so a
 * server or URL default cannot end its wait at the barrier before the
 * kill (request transactions set their own 30 s statement timeout).
 * @param url - The database.
 * @returns The URL with `options=-c lock_timeout=0`.
 */
const withoutLockTimeout = (url: string): string => {
  const parsed = new URL(url);

  parsed.searchParams.set("options", "-c lock_timeout=0");

  return parsed.toString();
};

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
        env: envFor(withoutLockTimeout(url)),
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

/** Whether this branch's `std upgrade` waits for a lock. */
const upgradeWaitsForLock = count(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = 'std-cli'
     AND wait_event_type = 'Lock'`
).pipe(Effect.map((waiting) => waiting > 0));

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

            // A barrier in the eighth batch: an uncommitted change entry
            // with the key (user, version 2) that the backfill's update of
            // that user will write, so the backfill waits for this
            // transaction there. It touches no table the set load changes.
            const [blocked] = yield* values(
              `SELECT id::text AS value FROM core."user" ORDER BY id OFFSET ${BARRIER_BATCH * BATCH + BATCH / 2} LIMIT 1`
            );

            const holding = yield* Deferred.make<boolean>();
            const unlock = yield* Deferred.make<boolean>();
            const { maintenance } = yield* Transactions;

            const barrier = yield* maintenance(
              Effect.gen(function* holdBarrier() {
                const sql = yield* SqlClient.SqlClient;

                yield* sql.unsafe(BARRIER_ENTRY, [blocked ?? ""]);
                yield* Deferred.succeed(holding, true);
                yield* Deferred.await(unlock);

                // Roll back: the entry was only ever a barrier.
                return yield* Effect.fail(new BarrierReleased());
              })
            ).pipe(Effect.flip, Effect.forkChild);

            yield* Deferred.await(holding);

            // This branch's upgrade, killed (SIGKILL) once it waits at the
            // barrier: seven batches committed, the eighth in flight.
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

            // Users created while the data migration is under way, started
            // as soon as it runs, so the upgrade waits at the barrier as
            // briefly as possible before the kill.
            yield* waitUntil(
              ledger.pipe(Effect.map((row) => row.startsWith("running")))
            );

            const during = yield* Effect.forkChild(
              concurrentUsers(database.url, "during-run")
            );

            yield* waitUntil(
              Effect.all([ledger, upgradeWaitsForLock]).pipe(
                Effect.map(
                  ([row, waiting]) => row.startsWith("running {") && waiting
                )
              )
            );
            yield* Fiber.join(during);

            // Still waiting at the barrier, so only the kill ends it: an
            // upgrade that gave up on its own fails the test.
            assert.isNull(child.exitCode, "std upgrade exited before the kill");
            assert.isTrue(yield* upgradeWaitsForLock);

            yield* Fiber.interrupt(upgrade);

            assert.strictEqual(child.signalCode, "SIGKILL");
            assert.isNull(child.exitCode);
            yield* Deferred.succeed(unlock, true);
            yield* Fiber.join(barrier);
            yield* waitUntil(cliGone);

            const stopped = yield* ledger;
            const done = BARRIER_BATCH * BATCH;

            assert.isTrue(stopped.startsWith("running "), stopped);
            assert.include(stopped, `"changed": ${done}`);
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
