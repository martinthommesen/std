import { assert, describe, it, layer } from "@effect/vitest";
/**
 * Diagnostic transactions (`Transactions.diagnostic`, for `doctor`):
 * REPEATABLE READ READ ONLY, no `begin_request()`, so they take no advisory
 * lock and run while another session holds `CONFIG_KEY` and `SCHEMA_KEY`
 * exclusively; Postgres refuses writes; they cannot nest.
 */
import { Duration, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import { CONFIG_KEY, SCHEMA_KEY } from "../src/sql/locks.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { readOnly } from "../src/sql/statement-marks.ts";
import {
  DIAGNOSTIC_BEGIN_STATEMENT,
  DIAGNOSTIC_ISOLATION,
} from "../src/sql/transaction.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { errorOf, refusalOf } from "./support.ts";

const decodeSettings = decodeRows(
  Schema.Struct({ isolation: Schema.String, read_only: Schema.String })
);

const settings = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) =>
    readOnly(
      sql`SELECT current_setting('transaction_isolation') AS isolation,
                 current_setting('transaction_read_only') AS read_only`
    )
  ),
  Effect.flatMap(decodeSettings)
);

describe("diagnostic-transaction", () => {
  it("begins REPEATABLE READ READ ONLY", () => {
    assert.strictEqual(
      DIAGNOSTIC_BEGIN_STATEMENT,
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    assert.strictEqual(DIAGNOSTIC_ISOLATION, "repeatable read");
  });

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "runs read-only at one snapshot without advisory locks, also while CONFIG_KEY and SCHEMA_KEY are held",
      () =>
        Effect.scoped(
          Effect.gen(function* diagnostic() {
            const database = yield* TestDatabase;
            const holder = yield* database.session("lock-holder");
            const log = yield* StatementLog;
            const transactions = yield* Transactions;

            yield* holder.query(
              `SELECT pg_advisory_lock(${CONFIG_KEY.toString()}), pg_advisory_lock(${SCHEMA_KEY.toString()})`
            );
            yield* log.clear;

            const [row] = yield* transactions.diagnostic(settings).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(30),
                orElse: () => Effect.die(new Error("waited on a lock")),
              })
            );

            assert.deepStrictEqual(row, {
              isolation: "repeatable read",
              read_only: "on",
            });
            assert.deepStrictEqual(
              (yield* log.texts).filter(
                (text) =>
                  text.includes("advisory") || text.includes("begin_request")
              ),
              []
            );
          })
        )
    );

    dbTest.effect("refuses writes and nesting", () =>
      Effect.gen(function* refusals() {
        const transactions = yield* Transactions;

        const write = errorOf(
          yield* Effect.exit(
            transactions.diagnostic(
              SqlClient.SqlClient.pipe(
                Effect.flatMap(
                  (sql) =>
                    sql`UPDATE core.config_state SET revision = revision + 1`
                )
              )
            )
          )
        );

        assert.strictEqual(write?._tag, "DatabaseError");
        assert.strictEqual(
          write !== undefined && "sqlState" in write ? write.sqlState : "",
          "25006"
        );

        const nested = yield* Effect.exit(
          transactions.request(transactions.diagnostic(Effect.void))
        );

        assert.strictEqual(refusalOf(nested)?.reason, "nesting");
      })
    );
  });
});
