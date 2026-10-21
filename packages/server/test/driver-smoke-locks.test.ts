/**
 * Plan 0A driver smoke test, part 2: the dedicated connection and
 * `SCHEMA_KEY`, `begin_request()` against a concurrent config commit, and
 * config-commit lock-timeout retries.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import {
  bumpRevision,
  CONFIG_LOCK_TIMEOUT,
  DEFAULT_RETRY_DELAYS,
  MAIN_LOCK_TIMEOUT,
  MAIN_STATEMENT_TIMEOUT,
  retrySchedule,
  SchemaLockTimeout,
} from "../src/sql/config-commit.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";
import { DatabaseError } from "../src/sql/errors.ts";
import {
  advisoryClassId,
  advisoryObjectId,
  CONFIG_KEY,
  SCHEMA_KEY,
} from "../src/sql/locks.ts";
import { RequestRevision } from "../src/sql/request-revision.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { lockWaiting } from "../src/sql/statement-marks.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { changeSetId, defectTextOf, errorOf, waitUntil } from "./support.ts";

const FAST_RETRIES = [
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
];

const LOCK_STATEMENT = `SELECT pg_advisory_xact_lock(${CONFIG_KEY.toString()})`;

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const decodePids = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeSetting = decodeRows(Schema.Struct({ setting: Schema.String }));

const decodeValid = decodeRows(Schema.Struct({ valid: Schema.Boolean }));

const decodeRevision = decodeRows(Schema.Struct({ revision: Schema.String }));

const configKeyWaiters = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${String(advisoryClassId(CONFIG_KEY))}::oid
        AND objid = ${String(advisoryObjectId(CONFIG_KEY))}::oid`
  ),
  Effect.flatMap(decodeCount),
  Effect.map(([row]) => row?.n ?? 0)
);

const concurrentRequests = Transactions.pipe(
  Effect.flatMap(({ request }) =>
    Effect.all(
      Array.from({ length: 20 }, () => request(RequestRevision)),
      { concurrency: 10 }
    )
  )
);

const schemaKeyHolders = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${String(advisoryClassId(SCHEMA_KEY))}::oid
        AND objid = ${String(advisoryObjectId(SCHEMA_KEY))}::oid`
  ),
  Effect.flatMap(decodePids),
  Effect.map((rows) => rows.map((row) => row.pid))
);

const currentRevision = Transactions.pipe(
  Effect.flatMap(({ request }) => request(RequestRevision)),
  Effect.map((state) => state.revision)
);

const lockAttempts = StatementLog.pipe(
  Effect.flatMap((log) => log.texts),
  Effect.map((texts) => texts.filter((text) => text === LOCK_STATEMENT).length)
);

describe("driver-smoke-locks", () => {
  it("config commits use the Contracts 1.4 timeouts and retry delays", () => {
    assert.deepStrictEqual(
      [CONFIG_LOCK_TIMEOUT, MAIN_LOCK_TIMEOUT, MAIN_STATEMENT_TIMEOUT],
      ["200ms", "2s", "15s"]
    );
    assert.deepStrictEqual(
      DEFAULT_RETRY_DELAYS.map((delay) => Duration.toMillis(delay)),
      [500, 1000, 2000, 4000]
    );
  });

  it.effect(
    "the retry policy waits 0.5, 1, 2 and 4 s between the 5 attempts",
    () =>
      Effect.gen(function* retryDelays() {
        const startedAt: number[] = [];

        const attempt = Clock.currentTimeMillis.pipe(
          Effect.tap((now) => Effect.sync(() => startedAt.push(now))),
          Effect.andThen(Effect.fail("lock timeout" as const))
        );

        const retried = yield* Effect.forkChild(
          Effect.exit(
            attempt.pipe(Effect.retry(retrySchedule(DEFAULT_RETRY_DELAYS)))
          )
        );

        yield* TestClock.adjust(Duration.seconds(10));
        const exit = yield* Fiber.join(retried);

        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(startedAt, [0, 500, 1500, 3500, 7500]);

        // Without delays there is exactly one attempt.
        yield* Effect.exit(attempt.pipe(Effect.retry(retrySchedule([]))));
        assert.lengthOf(startedAt, 6);
      })
  );

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a dedicated connection holds SCHEMA_KEY while pooled requests continue",
      () =>
        Effect.gen(function* dedicatedHoldsSchemaKey() {
          const sql = yield* SqlClient.SqlClient;

          const holder = yield* Effect.scoped(
            Effect.gen(function* holdSchemaKey() {
              const coordinator = yield* makeDedicatedConnection({
                applicationName: "smoke-coordinator",
              });

              const other = yield* makeDedicatedConnection({
                applicationName: "smoke-other",
              });

              assert.isTrue(yield* coordinator.tryAdvisoryLock(SCHEMA_KEY));

              const started = Date.now();

              assert.isFalse(yield* other.tryAdvisoryLock(SCHEMA_KEY));
              assert.isBelow(
                Date.now() - started,
                1000,
                "try-lock never waits"
              );

              const revisions = yield* concurrentRequests;

              assert.lengthOf(revisions, 20);

              assert.deepStrictEqual(yield* schemaKeyHolders, [
                coordinator.processId,
              ]);

              for (const [name, value] of [
                ["tcp_keepalives_idle", "30"],
                ["tcp_keepalives_interval", "10"],
                ["tcp_keepalives_count", "3"],
              ] as const) {
                const [setting] = yield* coordinator
                  .execute(`SELECT current_setting('${name}') AS setting`)
                  .pipe(Effect.flatMap(decodeSetting));

                assert.strictEqual(setting?.setting, value, name);
              }

              yield* sql`CREATE TABLE smoke_dedicated (id int)`;
              yield* sql`INSERT INTO smoke_dedicated SELECT generate_series(1, 1000)`;
              yield* coordinator.execute(
                "CREATE INDEX CONCURRENTLY smoke_dedicated_id ON smoke_dedicated (id)"
              );

              const [index] = yield* sql`
                SELECT indisvalid AS valid FROM pg_index
                WHERE indexrelid = 'smoke_dedicated_id'::regclass`.pipe(
                Effect.flatMap(decodeValid)
              );

              assert.isTrue(index?.valid);

              const committed = yield* coordinator.transactions.configCommit(
                bumpRevision(changeSetId())
              );

              assert.strictEqual(
                committed.revision,
                revisions[0] === undefined ? -1 : revisions[0].revision + 1
              );

              return coordinator.processId;
            })
          );

          // Closing the connection released the session lock.
          const released = yield* Effect.scoped(
            makeDedicatedConnection({ applicationName: "smoke-next" }).pipe(
              Effect.flatMap((next) => next.tryAdvisoryLock(SCHEMA_KEY))
            )
          );

          assert.isTrue(released, `pid ${holder} released SCHEMA_KEY`);
        })
    );

    dbTest.effect(
      "begin_request() sees a config commit that finished while it waited on the shared lock",
      () =>
        Effect.scoped(
          Effect.gen(function* beginRequestSeesConfigCommit() {
            const { configCommit, request } = yield* Transactions;
            const database = yield* TestDatabase;
            const before = yield* currentRevision;
            const holding = yield* Deferred.make<boolean>();
            const release = yield* Deferred.make<boolean>();

            const committer = yield* Effect.forkChild(
              configCommit(
                Effect.gen(function* bumpAndHold() {
                  const next = yield* bumpRevision(changeSetId());
                  yield* Deferred.succeed(holding, true);
                  yield* Deferred.await(release);

                  return next;
                })
              )
            );

            yield* Deferred.await(holding);

            const waiter = yield* Effect.forkChild(request(RequestRevision));

            // Under REPEATABLE READ the snapshot is taken before the lock
            // wait, which is why STD refuses that level (Contracts 1.3).
            const repeatable = yield* database.session("smoke-repeatable-read");
            yield* repeatable.query("BEGIN ISOLATION LEVEL REPEATABLE READ");

            const staleRead = yield* Effect.forkChild(
              repeatable.query("SELECT revision FROM core.begin_request()")
            );

            yield* waitUntil(
              configKeyWaiters.pipe(Effect.map((waiting) => waiting >= 2))
            );
            yield* Deferred.succeed(release, true);

            const committed = yield* Fiber.join(committer);
            const seen = yield* Fiber.join(waiter);

            const stale = yield* Fiber.join(staleRead).pipe(
              Effect.flatMap((result) => decodeRevision(result.rows))
            );

            yield* repeatable.query("ROLLBACK");

            assert.strictEqual(committed.revision, before + 1);
            assert.deepStrictEqual(seen, committed);
            assert.strictEqual(stale[0]?.revision, String(before));
          })
        )
    );

    dbTest.effect(
      "config commits retry lock timeouts 5 times, then fail with SchemaLockTimeout naming the blocker",
      () =>
        Effect.scoped(
          Effect.gen(function* configKeyTimeout() {
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const log = yield* StatementLog;
            const before = yield* currentRevision;
            const blocker = yield* database.session("smoke-config-blocker");
            yield* blocker.query(
              `SELECT pg_advisory_lock(${CONFIG_KEY.toString()})`
            );
            yield* log.clear;

            const exit = yield* Effect.exit(
              configCommit(bumpRevision(changeSetId()), {
                retryDelays: FAST_RETRIES,
              })
            );

            const timeout = errorOf(exit);

            assert.instanceOf(timeout, SchemaLockTimeout);
            assert.strictEqual(timeout?.attempts, 5);
            assert.strictEqual(yield* lockAttempts, 5);

            const holder = timeout?.holders.find(
              (candidate) => candidate.pid === blocker.processId
            );

            assert.strictEqual(holder?.applicationName, "smoke-config-blocker");
            assert.include(holder?.locks ?? [], "advisory ExclusiveLock");
            assert.include(timeout?.message ?? "", String(blocker.processId));

            yield* blocker.query(
              `SELECT pg_advisory_unlock(${CONFIG_KEY.toString()})`
            );
            assert.strictEqual(yield* currentRevision, before);
          })
        )
    );

    dbTest.effect(
      "with the default delays a config commit retries until the lock is free",
      () =>
        Effect.scoped(
          Effect.gen(function* configKeyRetrySucceeds() {
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const log = yield* StatementLog;
            const before = yield* currentRevision;
            const blocker = yield* database.session("smoke-config-holder");
            yield* blocker.query(
              `SELECT pg_advisory_lock(${CONFIG_KEY.toString()})`
            );
            yield* log.clear;

            const committer = yield* Effect.forkChild(
              configCommit(bumpRevision(changeSetId()))
            );

            // Release the lock once the second attempt has started.
            yield* waitUntil(lockAttempts.pipe(Effect.map((n) => n >= 2)));
            yield* blocker.query(
              `SELECT pg_advisory_unlock(${CONFIG_KEY.toString()})`
            );

            const committed = yield* Fiber.join(committer);

            assert.strictEqual(committed.revision, before + 1);
            assert.isAtLeast(yield* lockAttempts, 2);
          })
        )
    );

    dbTest.effect(
      "with the default delays all 5 attempts take the Contracts 1.4 schedule",
      () =>
        Effect.scoped(
          Effect.gen(function* configKeyDefaultSchedule() {
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const blocker = yield* database.session("smoke-config-slow");
            yield* blocker.query(
              `SELECT pg_advisory_lock(${CONFIG_KEY.toString()})`
            );

            const started = Date.now();

            const exit = yield* Effect.exit(
              configCommit(bumpRevision(changeSetId()))
            );

            const elapsed = Date.now() - started;

            assert.instanceOf(errorOf(exit), SchemaLockTimeout);
            // 5 waits of 200 ms plus 0.5 + 1 + 2 + 4 s with +/-20% jitter.
            assert.isAtLeast(elapsed, 7000);
            assert.isBelow(elapsed, 12_000);

            yield* blocker.query(
              `SELECT pg_advisory_unlock(${CONFIG_KEY.toString()})`
            );
          })
        ),
      { timeout: 30_000 }
    );

    dbTest.effect(
      "only the CONFIG_KEY wait and lockWaiting DDL are retried; any other 55P03 propagates at once",
      () =>
        Effect.scoped(
          Effect.gen(function* otherLockTimeouts() {
            const sql = yield* SqlClient.SqlClient;
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const log = yield* StatementLog;
            const before = yield* currentRevision;
            yield* sql`CREATE TABLE smoke_nowait (id int PRIMARY KEY)`;
            yield* sql`INSERT INTO smoke_nowait VALUES (1)`;
            yield* sql`
              CREATE FUNCTION smoke_raise_lock_timeout() RETURNS void LANGUAGE plpgsql AS
              $$ BEGIN RAISE EXCEPTION 'raised' USING ERRCODE = '55P03'; END $$`;

            const holder = yield* database.session("smoke-row-holder");
            yield* holder.query("BEGIN");
            yield* holder.query("SELECT id FROM smoke_nowait FOR UPDATE");

            const attempts = [
              sql`SELECT id FROM smoke_nowait FOR UPDATE NOWAIT`,
              sql`SELECT smoke_raise_lock_timeout()`,
              sql`ALTER TABLE smoke_nowait ADD COLUMN extra int`,
            ];

            for (const statement of attempts) {
              yield* log.clear;

              const failure = errorOf(
                yield* Effect.exit(
                  configCommit(statement, { retryDelays: FAST_RETRIES })
                )
              );

              assert.instanceOf(failure, DatabaseError);
              assert.strictEqual(
                failure instanceof DatabaseError ? failure.sqlState : "",
                "55P03"
              );
              assert.strictEqual(yield* lockAttempts, 1, "no retry");
            }

            yield* holder.query("ROLLBACK");
            assert.strictEqual(yield* currentRevision, before);
          })
        ),
      { timeout: 30_000 }
    );

    dbTest.effect(
      "a DDL lock wait times out after 2 s per attempt and names the session holding the table",
      () =>
        Effect.scoped(
          Effect.gen(function* ddlLockTimeout() {
            const sql = yield* SqlClient.SqlClient;
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const before = yield* currentRevision;
            yield* sql`CREATE TABLE smoke_ddl (id int)`;

            const blocker = yield* database.session("smoke-table-reader");
            yield* blocker.query("BEGIN");
            yield* blocker.query("SELECT count(*) FROM smoke_ddl");

            const started = Date.now();

            const exit = yield* Effect.exit(
              configCommit(
                lockWaiting(
                  sql`ALTER TABLE smoke_ddl ADD COLUMN extra int`
                ).pipe(Effect.andThen(bumpRevision(changeSetId()))),
                { retryDelays: FAST_RETRIES }
              )
            );

            const timeout = errorOf(exit);

            assert.instanceOf(timeout, SchemaLockTimeout);
            assert.isAtLeast(Date.now() - started, 5 * 2000);

            const holder = timeout?.holders.find(
              (candidate) => candidate.pid === blocker.processId
            );

            assert.include(
              holder?.locks ?? [],
              "relation AccessShareLock on smoke_ddl"
            );
            assert.strictEqual(holder?.state, "idle in transaction");
            yield* blocker.query("ROLLBACK");

            const [column] = yield* sql`
              SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'smoke_ddl' AND column_name = 'extra'`.pipe(
              Effect.flatMap(decodeCount)
            );

            assert.strictEqual(column?.n, 0);
            assert.strictEqual(yield* currentRevision, before);
          })
        ),
      { timeout: 30_000 }
    );

    dbTest.effect(
      "a defect next to a lock timeout is not retried and keeps its cause",
      () =>
        Effect.scoped(
          Effect.gen(function* defectNextToLockTimeout() {
            const sql = yield* SqlClient.SqlClient;
            const { configCommit } = yield* Transactions;
            const database = yield* TestDatabase;
            const log = yield* StatementLog;
            const before = yield* currentRevision;
            yield* sql`CREATE TABLE smoke_defect (id int)`;

            const blocker = yield* database.session("smoke-defect-reader");
            yield* blocker.query("BEGIN");
            yield* blocker.query("SELECT count(*) FROM smoke_defect");

            const alter = lockWaiting(
              sql`ALTER TABLE smoke_defect ADD COLUMN extra int`
            );

            // The error handler of the timed-out DDL dies.
            yield* log.clear;

            const handlerDied = yield* Effect.exit(
              configCommit(
                alter.pipe(
                  Effect.catchTag("SqlError", () =>
                    Effect.die(new Error("handler defect"))
                  )
                ),
                { retryDelays: FAST_RETRIES }
              )
            );

            assert.notInstanceOf(errorOf(handlerDied), SchemaLockTimeout);
            assert.include(defectTextOf(handlerDied) ?? "", "handler defect");
            assert.strictEqual(yield* lockAttempts, 1, "no retry");

            // A scope finalizer of the transaction's code dies after the timeout.
            yield* log.clear;

            const finalizerDied = yield* Effect.exit(
              configCommit(
                Effect.addFinalizer(() =>
                  Effect.die(new Error("finalizer defect"))
                ).pipe(Effect.andThen(alter)),
                { retryDelays: FAST_RETRIES }
              )
            );

            assert.notInstanceOf(errorOf(finalizerDied), SchemaLockTimeout);
            assert.include(
              defectTextOf(finalizerDied) ?? "",
              "finalizer defect"
            );
            assert.strictEqual(yield* lockAttempts, 1, "no retry");

            yield* blocker.query("ROLLBACK");
            assert.strictEqual(yield* currentRevision, before);
          })
        ),
      { timeout: 30_000 }
    );
  });
});
