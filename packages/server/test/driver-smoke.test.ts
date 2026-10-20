/**
 * Plan 0A driver smoke test, part 1: transactions, text reads, session
 * parameters, isolation and error hygiene.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";
import { DatabaseError } from "../src/sql/errors.ts";
import {
  advisoryClassId,
  advisoryObjectId,
  CONFIG_KEY,
  SCHEMA_KEY,
  STD_LOCK_CLASS_ID,
} from "../src/sql/locks.ts";
import { RequestRevision } from "../src/sql/request-revision.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { CurrentTransaction } from "../src/sql/transaction-context.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { defectTextOf, errorOf, refusalOf } from "./support.ts";

const SAVEPOINT_STATEMENT = /^\s*(?:savepoint|release|rollback\s+to)\b/iu;

const UUID_V7 =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const countRows = (table: string) =>
  Effect.gen(function* countTableRows() {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql
      .unsafe(`SELECT count(*)::int AS n FROM ${table}`)
      .pipe(Effect.flatMap(decodeCount));

    return row?.n ?? -1;
  });

const TextReadCases: readonly (readonly [string, readonly string[]])[] = [
  [
    "numeric",
    [
      "0",
      "-1",
      "1.5",
      "0.0001",
      "-0.00000001",
      "1.000000",
      "9999.9999",
      "10000",
      "123456789012345678901234567890.123456789012345678901234567890",
      "1e-20",
      "-1e20",
      "NaN",
      "Infinity",
      "-Infinity",
    ],
  ],
  ["int8", ["0", "-1", "9223372036854775807", "-9223372036854775808"]],
  [
    "date",
    [
      "2000-01-01",
      "1999-12-31",
      "1970-01-01",
      "0001-01-01",
      "9999-12-31",
      "2024-02-29",
      "1900-03-01",
      "0001-12-31 BC",
      "4713-01-01 BC",
      "5874897-12-31",
      "infinity",
      "-infinity",
    ],
  ],
  [
    "timestamptz",
    [
      "1970-01-01 00:00:00+00",
      "2000-01-01 00:00:00+00",
      "1999-12-31 23:59:59.999999+00",
      "2026-10-20 12:34:56.789+02",
      "2026-03-29 02:30:00 Europe/Berlin",
      "0001-01-01 00:00:00+00",
      "9999-12-31 23:59:59.999+00",
      "4713-01-01 00:00:00+00 BC",
      "294276-12-31 23:59:59.999999+00",
      "infinity",
      "-infinity",
    ],
  ],
  [
    "timestamp",
    [
      "2026-10-20 12:00:00.5",
      "2000-01-01 00:00:00",
      "1999-12-31 23:59:59.000001",
      "0001-01-01 00:00:00 BC",
      "infinity",
    ],
  ],
  ["json", ['{"b": 1,   "a": [1,2]}', '"x"', "null"]],
  ["jsonb", ['{"b": 1,   "a": [1,2]}', "[]", '{"a": {"c": 1.50}}']],
];

const decodeTextRead = decodeRows(
  Schema.Struct({ t: Schema.String, v: Schema.String })
);

const EdgeRow = Schema.Struct({
  bound_text: Schema.String,
  dates: Schema.Array(Schema.String),
  int8s: Schema.Array(Schema.String),
  min_int8: Schema.String,
  normalized_jsonb: Schema.String,
  numerics: Schema.Array(Schema.NullOr(Schema.String)),
  raw_json: Schema.String,
  shifted: Schema.String,
  tiny: Schema.String,
  whole_second: Schema.String,
  year_zero: Schema.String,
});

const decodeEdges = decodeRows(EdgeRow);

const decodeSession = decodeRows(
  Schema.Struct({
    app: Schema.String,
    ds: Schema.String,
    pid: Schema.Int,
    tz: Schema.String,
  })
);

const decodeSettings = decodeRows(
  Schema.Struct({ ds: Schema.String, tz: Schema.String })
);

const decodeIsolation = decodeRows(
  Schema.Struct({ transaction_isolation: Schema.String })
);

const decodeDefaultIsolation = decodeRows(
  Schema.Struct({ default_transaction_isolation: Schema.String })
);

const decodeUuid = decodeRows(
  Schema.Struct({ id: Schema.String, version: Schema.Int })
);

const decodeState = decodeRows(
  Schema.Struct({ change_set_id: Schema.String, revision: Schema.String })
);

const recorder =
  (events: string[]) =>
  (event: string): Effect.Effect<void> =>
    Effect.sync(() => {
      events.push(event);
    });

const registerAfterCommit = (action: Effect.Effect<void>) =>
  CurrentTransaction.pipe(
    Effect.flatMap((transaction) => transaction.afterCommit(action))
  );

const showIsolation = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql`SHOW transaction_isolation`),
  Effect.flatMap(decodeIsolation),
  Effect.map(([row]) => row?.transaction_isolation)
);

describe("driver-smoke", () => {
  it("lock keys have their documented values", () => {
    assert.strictEqual(CONFIG_KEY, 6_004_498_969_982_402_561n);
    assert.strictEqual(SCHEMA_KEY, 6_004_498_969_982_402_562n);
    assert.deepStrictEqual(
      [advisoryClassId(CONFIG_KEY), advisoryObjectId(CONFIG_KEY)],
      [STD_LOCK_CLASS_ID, 1]
    );
    assert.deepStrictEqual(
      [advisoryClassId(SCHEMA_KEY), advisoryObjectId(SCHEMA_KEY)],
      [STD_LOCK_CLASS_ID, 2]
    );
  });

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a request transaction starts with BEGIN, the timeouts and begin_request()",
      () =>
        Effect.gen(function* requestStatementOrder() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          const log = yield* StatementLog;
          yield* log.clear;

          const revision = yield* request(
            sql`SELECT 1 AS one`.pipe(Effect.andThen(RequestRevision))
          );

          assert.deepStrictEqual(yield* log.texts, [
            "BEGIN ISOLATION LEVEL READ COMMITTED",
            "SET LOCAL statement_timeout = '30s'",
            "SET LOCAL idle_in_transaction_session_timeout = '10s'",
            "SELECT revision, change_set_id FROM core.begin_request()",
            "SELECT 1 AS one",
            "COMMIT",
          ]);

          const [state] = yield* sql`
          SELECT revision, change_set_id FROM core.config_state`.pipe(
            Effect.flatMap(decodeState)
          );

          assert.deepStrictEqual(revision, {
            changeSetId: state?.change_set_id ?? "",
            revision: Number(state?.revision),
          });
        })
    );

    dbTest.effect(
      "rollback: a failed request transaction leaves nothing behind",
      () =>
        Effect.gen(function* rollbackLeavesNothing() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE smoke_rollback (id int PRIMARY KEY)`;

          const exit = yield* Effect.exit(
            request(
              sql`INSERT INTO smoke_rollback VALUES (1)`.pipe(
                Effect.andThen(Effect.fail("boom" as const))
              )
            )
          );

          assert.strictEqual(errorOf(exit), "boom");
          assert.strictEqual(yield* countRows("smoke_rollback"), 0);
        })
    );

    dbTest.effect(
      "nested units join the outer transaction without SAVEPOINT",
      () =>
        Effect.gen(function* nestedUnitsJoin() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          const log = yield* StatementLog;
          yield* sql`CREATE TABLE smoke_nested (id int PRIMARY KEY)`;
          yield* log.clear;

          yield* request(
            Effect.gen(function* outerUnit() {
              yield* sql`INSERT INTO smoke_nested VALUES (1)`;
              yield* request(sql`INSERT INTO smoke_nested VALUES (2)`);
              yield* request(request(sql`INSERT INTO smoke_nested VALUES (3)`));
            })
          );

          const texts = yield* log.texts;

          assert.isFalse(texts.some((text) => SAVEPOINT_STATEMENT.test(text)));
          assert.lengthOf(
            texts.filter((text) => text.startsWith("BEGIN")),
            1
          );
          assert.lengthOf(
            texts.filter((text) => text.includes("core.begin_request()")),
            1
          );
          assert.lengthOf(
            texts.filter((text) => text === "COMMIT"),
            1
          );
          assert.strictEqual(yield* countRows("smoke_nested"), 3);
        })
    );

    dbTest.effect(
      "Effect's nested withTransaction issues SAVEPOINT, and nothing like it runs inside STD transactions",
      () =>
        Effect.gen(function* savepointsRefused() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          const log = yield* StatementLog;
          yield* sql`CREATE TABLE smoke_effect_tx (id int PRIMARY KEY)`;
          yield* log.clear;
          yield* sql.withTransaction(sql.withTransaction(sql`SELECT 1 AS one`));

          assert.include(yield* log.texts, "SAVEPOINT effect_sql_1");

          yield* log.clear;

          const exit = yield* Effect.exit(
            request(
              sql`INSERT INTO smoke_effect_tx VALUES (1)`.pipe(
                Effect.andThen(
                  sql.withTransaction(
                    sql`INSERT INTO smoke_effect_tx VALUES (2)`
                  )
                )
              )
            )
          );

          // Effect's nested path needs a semaphore that only its own outer
          // withTransaction provides, so it dies before sending anything.
          assert.include(defectTextOf(exit), "TransactionSemaphore");
          const texts = yield* log.texts;
          assert.isFalse(texts.some((text) => SAVEPOINT_STATEMENT.test(text)));
          assert.include(texts, "ROLLBACK");
          assert.strictEqual(yield* countRows("smoke_effect_tx"), 0);

          yield* log.clear;

          const handWritten = yield* Effect.exit(
            request(sql`SAVEPOINT manual`)
          );

          assert.strictEqual(refusalOf(handWritten)?.reason, "savepoint");
          assert.isFalse(
            (yield* log.texts).some((text) => SAVEPOINT_STATEMENT.test(text))
          );

          const commitInside = yield* Effect.exit(request(sql`COMMIT`));
          assert.strictEqual(
            refusalOf(commitInside)?.reason,
            "transaction-control"
          );
        })
    );

    dbTest.effect(
      "a poisoned transaction never commits, even when the caller catches the nested failure",
      () =>
        Effect.gen(function* poisonedNeverCommits() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          const log = yield* StatementLog;
          yield* sql`CREATE TABLE smoke_poison (id int PRIMARY KEY)`;
          yield* log.clear;

          const failingNestedUnit = request(
            sql`INSERT INTO smoke_poison VALUES (2)`.pipe(
              Effect.andThen(Effect.fail("nested failure" as const))
            )
          );

          const afterWrite = yield* Effect.exit(
            request(
              Effect.gen(function* outerCatchesNestedFailure() {
                yield* sql`INSERT INTO smoke_poison VALUES (1)`;
                yield* failingNestedUnit.pipe(Effect.ignore);
                yield* sql`INSERT INTO smoke_poison VALUES (3)`;
                const transaction = yield* CurrentTransaction;

                return yield* transaction.poisonReason;
              })
            )
          );

          const poisoned = refusalOf(afterWrite);
          assert.deepStrictEqual(
            [poisoned?.reason, poisoned?.detail],
            ["poisoned", "a nested unit failed after its first write"]
          );
          assert.strictEqual(yield* countRows("smoke_poison"), 0);
          const texts = yield* log.texts;
          assert.include(texts, "ROLLBACK");
          assert.notInclude(texts, "COMMIT");

          // A nested unit that fails before it writes does not poison.
          yield* request(
            sql`INSERT INTO smoke_poison VALUES (1)`.pipe(
              Effect.andThen(
                request(Effect.fail("validation failed" as const)).pipe(
                  Effect.ignore
                )
              )
            )
          );
          assert.strictEqual(yield* countRows("smoke_poison"), 1);

          // A caught SQL error poisons: Postgres has aborted the transaction.
          const caughtSqlError = yield* Effect.exit(
            request(
              sql`INSERT INTO smoke_poison VALUES (2)`.pipe(
                Effect.andThen(
                  sql`INSERT INTO smoke_poison VALUES (1)`.pipe(Effect.ignore)
                )
              )
            )
          );

          assert.strictEqual(refusalOf(caughtSqlError)?.reason, "poisoned");
          assert.strictEqual(yield* countRows("smoke_poison"), 1);
        })
    );

    dbTest.effect(
      "post-commit actions run after commit, in order, and never after a rollback",
      () =>
        Effect.gen(function* postCommitActions() {
          const { request } = yield* Transactions;
          const events: string[] = [];

          const record = recorder(events);

          yield* request(
            Effect.gen(function* registerActions() {
              const transaction = yield* CurrentTransaction;
              yield* transaction.afterCommit(record("first"));
              yield* request(registerAfterCommit(record("nested")));
              yield* transaction.afterCommit(
                Effect.die(new Error("post-commit failures are logged"))
              );
              yield* transaction.afterCommit(record("last"));
              yield* record("in transaction");
            })
          );
          assert.deepStrictEqual(events, [
            "in transaction",
            "first",
            "nested",
            "last",
          ]);

          events.length = 0;
          yield* Effect.exit(
            request(
              CurrentTransaction.pipe(
                Effect.flatMap((transaction) =>
                  transaction.afterCommit(record("never"))
                ),
                Effect.andThen(Effect.fail("rolled back" as const))
              )
            )
          );
          assert.deepStrictEqual(events, []);
        })
    );

    dbTest.effect("uuidv7() returns version 7 UUIDs", () =>
      Effect.gen(function* uuidVersionSeven() {
        const sql = yield* SqlClient.SqlClient;

        const [row] = yield* sql`
        SELECT id, uuid_extract_version(id) AS version
        FROM (SELECT uuidv7() AS id) AS generated`.pipe(
          Effect.flatMap(decodeUuid)
        );

        assert.match(row?.id ?? "", UUID_V7);
        assert.strictEqual(row?.version, 7);
      })
    );

    dbTest.effect(
      "text-format reads of numeric, int8, date, timestamp(tz) and json(b) equal Postgres text",
      () =>
        Effect.gen(function* textReads() {
          const sql = yield* SqlClient.SqlClient;

          for (const [type, literals] of TextReadCases) {
            const rows = yield* sql
              .unsafe(
                `SELECT s::${type} AS v, s::${type}::text AS t
               FROM unnest($1::text[]) WITH ORDINALITY AS u(s, i) ORDER BY i`,
                [literals]
              )
              .pipe(Effect.flatMap(decodeTextRead));

            assert.lengthOf(rows, literals.length);

            for (const row of rows) {
              assert.strictEqual(
                row.v,
                row.t,
                `${type} read equals Postgres text`
              );
            }
          }

          const [edges] = yield* sql`
          SELECT '1e-20'::numeric AS tiny,
                 '-9223372036854775808'::int8 AS min_int8,
                 '0001-12-31 BC'::date AS year_zero,
                 '2026-10-20 12:34:56.789+02'::timestamptz AS shifted,
                 '2026-10-20 12:34:56.000+00'::timestamptz AS whole_second,
                 '{"b": 1,   "a": [1,2]}'::json AS raw_json,
                 '{"b": 1,   "a": [1,2]}'::jsonb AS normalized_jsonb,
                 ARRAY['1.50'::numeric, NULL] AS numerics,
                 ARRAY[1::int8, -2] AS int8s,
                 ARRAY['2024-01-01'::date] AS dates,
                 ${"12.340"}::numeric AS bound_text`.pipe(
            Effect.flatMap(decodeEdges)
          );

          assert.deepStrictEqual(edges, {
            bound_text: "12.340",
            dates: ["2024-01-01"],
            int8s: ["1", "-2"],
            min_int8: "-9223372036854775808",
            normalized_jsonb: '{"a": [1, 2], "b": 1}',
            numerics: ["1.50", null],
            raw_json: '{"b": 1,   "a": [1,2]}',
            shifted: "2026-10-20 10:34:56.789+00",
            tiny: "0.00000000000000000001",
            whole_second: "2026-10-20 12:34:56+00",
            year_zero: "0001-12-31 BC",
          });
        })
    );

    dbTest.effect(
      "every session runs with TimeZone=UTC and DateStyle=ISO",
      () =>
        Effect.scoped(
          Effect.gen(function* sessionParameters() {
            const sql = yield* SqlClient.SqlClient;

            const sessions = yield* Effect.all(
              [1, 2, 3, 4].map(() =>
                sql`
              SELECT current_setting('TimeZone') AS tz,
                     current_setting('DateStyle') AS ds,
                     pg_backend_pid() AS pid,
                     current_setting('application_name') AS app,
                     pg_sleep(0.2)::text AS slept`.pipe(
                  Effect.flatMap(decodeSession)
                )
              ),
              { concurrency: 4 }
            );

            const rows = sessions.flat();

            assert.isAbove(
              new Set(rows.map((row) => row.pid)).size,
              1,
              "several pooled connections"
            );

            for (const row of rows) {
              assert.deepStrictEqual(
                [row.tz, row.ds, row.app],
                ["UTC", "ISO, MDY", "std-test"]
              );
            }

            yield* sql`RESET ALL`;

            const [reset] = yield* sql`
          SELECT current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds`.pipe(
              Effect.flatMap(decodeSettings)
            );

            assert.deepStrictEqual(reset, { ds: "ISO, MDY", tz: "UTC" });

            const dedicated = yield* makeDedicatedConnection({
              applicationName: "smoke-dedicated",
            });

            const [settings] = yield* dedicated
              .execute(
                "SELECT current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds"
              )
              .pipe(Effect.flatMap(decodeSettings));

            assert.deepStrictEqual(settings, { ds: "ISO, MDY", tz: "UTC" });
          })
        )
    );

    dbTest.effect(
      "only READ COMMITTED: other levels are refused, database defaults are overridden",
      () =>
        Effect.gen(function* onlyReadCommitted() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          const database = yield* TestDatabase;

          const serializable = yield* Effect.exit(
            request(sql`SELECT 1 AS one`, { isolation: "serializable" })
          );

          assert.strictEqual(
            refusalOf(serializable)?.reason,
            "isolation-level"
          );

          const repeatable = yield* Effect.exit(
            request(sql`SELECT 1 AS one`, { isolation: "repeatable read" })
          );

          assert.strictEqual(refusalOf(repeatable)?.reason, "isolation-level");

          const setInside = yield* Effect.exit(
            request(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
          );

          assert.strictEqual(refusalOf(setInside)?.reason, "isolation-level");

          const explicit = yield* request(showIsolation, {
            isolation: "read committed",
          });

          assert.strictEqual(explicit, "read committed");

          yield* sql.unsafe(
            `ALTER DATABASE "${database.name}" SET default_transaction_isolation = 'serializable'`
          );

          const levels = yield* Effect.scoped(
            Effect.gen(function* isolationOnFreshConnection() {
              const fresh = yield* makeDedicatedConnection({
                applicationName: "smoke-isolation",
              });

              const [defaults] = yield* fresh
                .execute("SHOW default_transaction_isolation")
                .pipe(Effect.flatMap(decodeDefaultIsolation));

              return {
                configCommit:
                  yield* fresh.transactions.configCommit(showIsolation),
                defaults: defaults?.default_transaction_isolation,
                request: yield* fresh.transactions.request(showIsolation),
              };
            })
          ).pipe(
            Effect.ensuring(
              Effect.ignore(
                sql.unsafe(
                  `ALTER DATABASE "${database.name}" RESET default_transaction_isolation`
                )
              )
            )
          );

          assert.deepStrictEqual(levels, {
            configCommit: "read committed",
            defaults: "serializable",
            request: "read committed",
          });
        })
    );

    dbTest.effect(
      "Postgres errors reach callers as DatabaseError with SQLSTATE and constraint only",
      () =>
        Effect.gen(function* errorHygiene() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE smoke_hygiene (name text CONSTRAINT smoke_hygiene_name UNIQUE)`;
          yield* sql`INSERT INTO smoke_hygiene VALUES ('secret-value')`;

          const duplicate = errorOf(
            yield* Effect.exit(
              request(sql`INSERT INTO smoke_hygiene VALUES ('secret-value')`)
            )
          );

          assert.instanceOf(duplicate, DatabaseError);
          assert.deepStrictEqual(
            [duplicate?.sqlState, duplicate?.constraint],
            ["23505", "smoke_hygiene_name"]
          );

          for (const rendered of [
            duplicate?.message ?? "",
            String(duplicate),
            JSON.stringify(duplicate),
          ]) {
            assert.notInclude(rendered, "secret-value");
            assert.notInclude(rendered, "duplicate key");
          }

          const syntax = errorOf(
            yield* Effect.exit(request(sql`SELEC 'secret-value'`))
          );

          assert.instanceOf(syntax, DatabaseError);
          assert.strictEqual(syntax?.sqlState, "42601");
          assert.notInclude(JSON.stringify(syntax), "secret-value");
        })
    );
  });
});
