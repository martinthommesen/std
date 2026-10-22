/**
 * Platform migrations (Contracts 1.9, 8.5): the startup check, the guards of
 * `std upgrade`, and crashes during `tx` and `concurrent_index` migrations.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import { MigrationStateRefused } from "../src/platform/ledger.ts";
import {
  migrationChecksum,
  validateMigrations,
} from "../src/platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0001 } from "../src/platform/migrations/0001-core.ts";
import {
  checkPlatformMigrations,
  runPlatformMigrations,
  UpgradeRefused,
} from "../src/platform/runner.ts";
import type { UpgradeError } from "../src/platform/runner.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";
import { SCHEMA_KEY } from "../src/sql/locks.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { killAndAwait, runCli } from "./cli-support.ts";
import {
  CHILD_APPLICATION_NAME,
  ITEM_INDEX_MIGRATIONS,
  ITEM_TABLE_MIGRATIONS,
  SLOW_TX_MIGRATIONS,
} from "./fixtures/test-migrations.ts";
import { errorOf, waitUntil } from "./support.ts";

/**
 * The `MigrationStateRefused` a check or upgrade failed with.
 * @param failure - The typed error, if any.
 * @returns The refusal, or `undefined` for other errors.
 */
const stateRefusal = (
  failure: UpgradeError | undefined
): MigrationStateRefused | undefined =>
  failure instanceof MigrationStateRefused ? failure : undefined;

const CHILD_SCRIPT = fileURLToPath(
  new URL("fixtures/run-migrations.ts", import.meta.url)
);

const decodeIds = decodeRows(Schema.Struct({ id: Schema.Int }));

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const decodeValidity = decodeRows(Schema.Struct({ valid: Schema.Boolean }));

const decodePids = decodeRows(Schema.Struct({ pid: Schema.Int }));

const ledgerIds = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`SELECT id FROM core.platform_migration ORDER BY id`
  ),
  Effect.flatMap(decodeIds),
  Effect.map((rows) => rows.map((row) => row.id))
);

const indexValidity = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`
      SELECT i.indisvalid AS valid FROM pg_index i
      WHERE i.indexrelid = to_regclass('core.migration_item_id')`
  ),
  Effect.flatMap(decodeValidity),
  Effect.map(([row]) => row?.valid)
);

/**
 * The backends of the migration child process.
 * @param filter - Extra SQL conditions on `pg_stat_activity`.
 * @returns Their PIDs.
 */
const childBackends = (filter: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1 ${filter}`,
        [CHILD_APPLICATION_NAME]
      )
    ),
    Effect.flatMap(decodePids),
    Effect.map((rows) => rows.map((row) => row.pid))
  );

const childGone = childBackends("").pipe(
  Effect.map((pids) => pids.length === 0)
);

/**
 * Starts the migration child process; it is killed, and awaited, when the
 * scope closes.
 * @param url - The database to migrate.
 * @param set - The migration list to run.
 * @returns The child process.
 */
const startChild = (
  url: string,
  set: string
): Effect.Effect<ChildProcess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [CHILD_SCRIPT, set], {
        env: { ...process.env, STD_DATABASE_URL: url },
        stdio: "ignore",
      })
    ),
    killAndAwait
  );

describe("platform-migrations", () => {
  it("migration lists are numbered from 1 without gaps and keep their checksums", () => {
    assert.deepStrictEqual(
      PLATFORM_MIGRATIONS.map((migration) => migration.id),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
    assert.strictEqual(
      migrationChecksum(migration0001),
      "b424af160a6c54634b7dbda0cba9e24c350c59b8a3aed3dc3ee18150de105534"
    );
    assert.throws(() => {
      validateMigrations([migration0001, { ...migration0001, id: 3 }]);
    });
    assert.throws(() => {
      validateMigrations([
        migration0001,
        {
          id: 2,
          index: "other_name",
          kind: "concurrent_index",
          name: "mismatch",
          schema: "core",
          statement: "CREATE INDEX CONCURRENTLY some_index ON core.t (id)",
        },
      ]);
    });
  });

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "the server refuses to start with a pending, unknown or changed migration",
        () =>
          Effect.gen(function* startupCheck() {
            const empty = yield* Effect.exit(checkPlatformMigrations());
            assert.deepStrictEqual(
              stateRefusal(errorOf(empty))?.pending,
              [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
            );

            const applied = yield* runPlatformMigrations([migration0001]);
            assert.deepStrictEqual(
              applied.map((outcome) => [outcome.id, outcome.outcome]),
              [[1, "applied"]]
            );
            yield* checkPlatformMigrations([migration0001]);

            const pending = errorOf(
              yield* Effect.exit(checkPlatformMigrations(SLOW_TX_MIGRATIONS))
            );

            assert.instanceOf(pending, MigrationStateRefused);
            assert.deepStrictEqual(stateRefusal(pending)?.pending, [2]);

            const unknown = errorOf(
              yield* Effect.exit(checkPlatformMigrations([]))
            );

            assert.deepStrictEqual(stateRefusal(unknown)?.unknown, [1]);

            const edited = {
              ...migration0001,
              statements: [...migration0001.statements, "SELECT 1"],
            };

            const changed = errorOf(
              yield* Effect.exit(checkPlatformMigrations([edited]))
            );

            assert.deepStrictEqual(stateRefusal(changed)?.changed, [1]);

            const upgradeChanged = errorOf(
              yield* Effect.exit(runPlatformMigrations([edited]))
            );

            assert.instanceOf(upgradeChanged, MigrationStateRefused);
            assert.deepStrictEqual(yield* ledgerIds, [1], "nothing applied");
          })
      );

      dbTest.effect(
        "std upgrade refuses while a std-server session is connected or SCHEMA_KEY is held",
        () =>
          Effect.scoped(
            Effect.gen(function* upgradeGuards() {
              const database = yield* TestDatabase;
              const server = yield* database.session("std-server");

              const connected = errorOf(
                yield* Effect.exit(runPlatformMigrations([migration0001]))
              );

              assert.instanceOf(connected, UpgradeRefused);
              assert.strictEqual(connected?.reason, "servers-connected");
              assert.deepStrictEqual(connected?.sessions, [server.processId]);

              const cli = yield* runCli(database.url, ["upgrade"]);
              assert.strictEqual(cli.code, 1);
              assert.include(cli.output, "std-server sessions are connected");
              assert.deepStrictEqual(yield* ledgerIds, [1], "nothing applied");
            })
          )
      );
    }
  );

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect("std upgrade refuses while SCHEMA_KEY is held", () =>
        Effect.scoped(
          Effect.gen(function* schemaBusy() {
            const coordinator = yield* makeDedicatedConnection({
              applicationName: "smoke-coordinator",
            });

            assert.isTrue(yield* coordinator.tryAdvisoryLock(SCHEMA_KEY));

            const busy = errorOf(
              yield* Effect.exit(runPlatformMigrations([migration0001]))
            );

            assert.instanceOf(busy, UpgradeRefused);
            assert.strictEqual(busy?.reason, "schema-busy");
            assert.deepStrictEqual(busy?.sessions, [coordinator.processId]);

            yield* coordinator.advisoryUnlock(SCHEMA_KEY);
            const applied = yield* runPlatformMigrations([migration0001]);
            assert.lengthOf(applied, 1);
          })
        )
      );
    }
  );

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "the std upgrade command applies migration 0001 and reruns as a no-op",
        () =>
          Effect.gen(function* upgradeCommand() {
            const database = yield* TestDatabase;
            const first = yield* runCli(database.url, ["upgrade"]);
            assert.strictEqual(first.code, 0);
            assert.include(
              first.output,
              "Platform migration 0001 core: applied"
            );

            const second = yield* runCli(database.url, ["upgrade"]);
            assert.strictEqual(second.code, 0);
            assert.include(second.output, "Platform migrations: up to date");
            yield* checkPlatformMigrations();

            const usage = yield* runCli(database.url, ["frobnicate"]);
            assert.strictEqual(usage.code, 2);
            assert.include(usage.output, "Usage: std <command>");
          })
      );
    }
  );

  layer(testDatabaseLayer({ encoding: "SQL_ASCII" }), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect("std upgrade refuses a database that is not UTF8", () =>
      Effect.gen(function* encodingGuard() {
        const refused = errorOf(
          yield* Effect.exit(runPlatformMigrations([migration0001]))
        );

        assert.instanceOf(refused, UpgradeRefused);
        assert.strictEqual(refused?.reason, "encoding");
        assert.strictEqual(refused?.encoding, "SQL_ASCII");
      })
    );
  });

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "killing std upgrade during a tx migration rolls it back; the rerun applies it once",
        () =>
          Effect.scoped(
            Effect.gen(function* killDuringTx() {
              const sql = yield* SqlClient.SqlClient;
              const database = yield* TestDatabase;
              const child = yield* startChild(database.url, "slow-tx");

              yield* waitUntil(
                childBackends("AND query LIKE 'SELECT pg_sleep%'").pipe(
                  Effect.map((pids) => pids.length === 1)
                )
              );
              yield* killAndAwait(child);
              // The backend finishes its statement, finds the client gone,
              // rolls back and exits, releasing SCHEMA_KEY.
              yield* waitUntil(childGone);

              assert.deepStrictEqual(yield* ledgerIds, [1]);

              const [probe] = yield* sql`
                SELECT count(*)::int AS n FROM pg_class
                WHERE oid = to_regclass('core.migration_probe')`.pipe(
                Effect.flatMap(decodeCount)
              );

              assert.strictEqual(probe?.n, 0, "the tx migration left nothing");

              const rerun = yield* runPlatformMigrations(SLOW_TX_MIGRATIONS);
              assert.deepStrictEqual(
                rerun.map((outcome) => [outcome.id, outcome.outcome]),
                [[2, "applied"]]
              );

              const [rows] = yield* sql`
                SELECT count(*)::int AS n FROM core.migration_probe`.pipe(
                Effect.flatMap(decodeCount)
              );

              assert.strictEqual(rows?.n, 1);
              assert.deepStrictEqual(yield* ledgerIds, [1, 2]);
              assert.lengthOf(
                yield* runPlatformMigrations(SLOW_TX_MIGRATIONS),
                0
              );
              yield* checkPlatformMigrations(SLOW_TX_MIGRATIONS);
            })
          ),
        { timeout: 120_000 }
      );
    }
  );

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "a concurrent index build that finishes after its client was killed is recorded on rerun",
        () =>
          Effect.scoped(
            Effect.gen(function* killClientDuringIndexBuild() {
              const database = yield* TestDatabase;
              yield* runPlatformMigrations(ITEM_TABLE_MIGRATIONS);

              const writer = yield* database.session("smoke-index-writer");
              yield* writer.query("BEGIN");
              yield* writer.query("INSERT INTO core.migration_item VALUES (0)");

              const child = yield* startChild(database.url, "item-index");
              yield* waitUntil(
                childBackends(
                  "AND query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock'"
                ).pipe(Effect.map((pids) => pids.length === 1))
              );
              yield* killAndAwait(child);
              yield* writer.query("COMMIT");
              // The build goes on without its client; the backend exits
              // when it ends.
              yield* waitUntil(childGone);

              assert.deepStrictEqual(yield* ledgerIds, [1, 2]);
              assert.isTrue(yield* indexValidity);

              const rerun = yield* runPlatformMigrations(ITEM_INDEX_MIGRATIONS);
              assert.deepStrictEqual(
                rerun.map((outcome) => [outcome.id, outcome.outcome]),
                [[3, "recorded"]]
              );
              assert.deepStrictEqual(yield* ledgerIds, [1, 2, 3]);
              yield* checkPlatformMigrations(ITEM_INDEX_MIGRATIONS);
            })
          ),
        { timeout: 120_000 }
      );
    }
  );

  layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "a concurrent index build killed on the server leaves an invalid index, which the rerun rebuilds",
        () =>
          Effect.scoped(
            Effect.gen(function* killBackendDuringIndexBuild() {
              const sql = yield* SqlClient.SqlClient;
              const database = yield* TestDatabase;
              yield* runPlatformMigrations(ITEM_TABLE_MIGRATIONS);

              const writer = yield* database.session("smoke-index-writer");
              yield* writer.query("BEGIN");
              yield* writer.query("INSERT INTO core.migration_item VALUES (0)");

              const child = yield* startChild(database.url, "item-index");
              yield* waitUntil(
                childBackends(
                  "AND query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock'"
                ).pipe(Effect.map((pids) => pids.length === 1))
              );
              yield* sql.unsafe(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = current_database() AND application_name = $1`,
                [CHILD_APPLICATION_NAME]
              );
              yield* waitUntil(childGone);
              yield* killAndAwait(child);
              yield* writer.query("COMMIT");

              assert.isFalse(yield* indexValidity, "an invalid index is left");
              assert.deepStrictEqual(yield* ledgerIds, [1, 2]);

              const rerun = yield* runPlatformMigrations(ITEM_INDEX_MIGRATIONS);
              assert.deepStrictEqual(
                rerun.map((outcome) => [outcome.id, outcome.outcome]),
                [[3, "rebuilt"]]
              );
              assert.isTrue(yield* indexValidity);
              assert.deepStrictEqual(yield* ledgerIds, [1, 2, 3]);
            })
          ),
        { timeout: 120_000 }
      );
    }
  );
});
