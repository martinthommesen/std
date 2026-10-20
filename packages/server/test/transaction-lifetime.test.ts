import { PgClient } from "@effect/sql-pg";
/**
 * Review round 2 reproductions: statements the allowlist refuses at run
 * time, a dying scope finalizer, detached fibers, the pre-COMMIT backstop,
 * a failed COMMIT, and `readOnly` on a write.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import { DatabaseError } from "../src/sql/errors.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { readOnly } from "../src/sql/statement-marks.ts";
import {
  READ_KEYWORDS,
  STATEMENT_KEYWORDS,
  TRANSACTION_SETTINGS,
  TransactionState,
} from "../src/sql/transaction-state.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { errorOf, refusalOf } from "./support.ts";

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeIsolation = decodeRows(
  Schema.Struct({ transaction_isolation: Schema.String })
);

const countRows = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)
    ),
    Effect.flatMap(decodeCount),
    Effect.map(([row]) => row?.n ?? -1)
  );

const backendPid = Transactions.pipe(
  Effect.flatMap(({ request }) =>
    request(
      SqlClient.SqlClient.pipe(
        Effect.flatMap((sql) => sql`SELECT pg_backend_pid() AS pid`)
      )
    )
  ),
  Effect.flatMap(decodePid),
  Effect.map(([row]) => row?.pid ?? -1)
);

const UNICODE_ISOLATION =
  "SET LOCAL U&\"transaction_\\0069solation\" = 'serializable'";

/**
 * A request whose body detaches a nested unit that writes, signals and then
 * fails later; the body returns as soon as the write happened.
 * @returns The request.
 */
const detachedWriter = Effect.gen(function* detachWriter() {
  const sql = yield* SqlClient.SqlClient;
  const { request } = yield* Transactions;
  const wrote = yield* Deferred.make<boolean>();

  const writer = request(
    sql`INSERT INTO lifetime_detached VALUES (1)`.pipe(
      Effect.andThen(Deferred.succeed(wrote, true)),
      Effect.andThen(Effect.sleep(Duration.millis(300))),
      Effect.andThen(Effect.fail("late failure" as const))
    )
  ).pipe(Effect.ignore);

  return yield* request(
    Effect.forkDetach(writer).pipe(Effect.andThen(Deferred.await(wrote)))
  );
});

describe("transaction-lifetime", () => {
  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a leading empty statement or a CR-ended comment cannot hide COMMIT",
      () =>
        Effect.gen(function* hiddenCommits() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE lifetime_hidden (id int PRIMARY KEY)`;

          for (const hidden of [";COMMIT", "-- comment\rCOMMIT"]) {
            const exit = yield* Effect.exit(
              request(
                sql`INSERT INTO lifetime_hidden VALUES (1)`.pipe(
                  Effect.andThen(sql.unsafe(hidden)),
                  Effect.andThen(Effect.fail("then fail" as const))
                )
              )
            );

            assert.strictEqual(
              refusalOf(exit)?.reason,
              "transaction-control",
              hidden
            );
          }

          assert.strictEqual(yield* countRows("lifetime_hidden"), 0);
        })
    );

    dbTest.effect(
      "SET LOCAL of a U& quoted name is refused and the isolation stays READ COMMITTED",
      () =>
        Effect.gen(function* unicodeSet() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;

          const isolation = yield* request(
            Effect.gen(function* tryUnicodeSet() {
              const refused = yield* Effect.exit(sql.unsafe(UNICODE_ISOLATION));
              assert.isDefined(refusalOf(refused));

              const [row] = yield* sql`SHOW transaction_isolation`.pipe(
                Effect.flatMap(decodeIsolation)
              );

              return row?.transaction_isolation;
            })
          );

          assert.strictEqual(isolation, "read committed");
        })
    );

    dbTest.effect(
      "a detached fiber that wrote is interrupted before the commit decision",
      () =>
        Effect.gen(function* detachedFiber() {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE lifetime_detached (id int PRIMARY KEY)`;

          const exit = yield* Effect.exit(detachedWriter);

          assert.strictEqual(refusalOf(exit)?.reason, "poisoned");
          yield* Effect.sleep(Duration.millis(400));
          assert.strictEqual(yield* countRows("lifetime_detached"), 0);
        })
    );

    dbTest.effect(
      "a fiber that first uses a transaction after its code ended is refused",
      () =>
        Effect.gen(function* foreignFiber() {
          const client = yield* PgClient.PgClient;
          const state = new TransactionState("request", client);
          yield* state.enter("the owner");
          state.sealed = true;

          yield* state.enter("the owner again");

          const stranger = yield* Effect.exit(
            Effect.forkChild(state.enter("a stranger")).pipe(
              Effect.flatMap(Fiber.join)
            )
          );

          assert.strictEqual(refusalOf(stranger)?.reason, "foreignFiber");

          state.closed = true;
          const late = yield* Effect.exit(state.enter("the owner, late"));
          assert.strictEqual(refusalOf(late)?.reason, "closed");
        })
    );

    dbTest.effect(
      "the check before COMMIT rolls back when the transaction's mark changed",
      () =>
        Effect.gen(function* backstop() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE lifetime_backstop (id int PRIMARY KEY)`;

          const exit = yield* Effect.exit(
            request(
              sql`INSERT INTO lifetime_backstop VALUES (1)`.pipe(
                Effect.andThen(
                  sql`SELECT set_config('std.transaction_token', 'forged', true)`
                )
              )
            )
          );

          const refused = refusalOf(exit);

          assert.strictEqual(refused?.reason, "transaction-control");
          assert.include(refused?.detail ?? "", "no longer in the transaction");
          assert.strictEqual(yield* countRows("lifetime_backstop"), 0);
        })
    );

    dbTest.effect("readOnly refuses a statement that is not a read", () =>
      Effect.gen(function* readOnlyWrite() {
        const sql = yield* SqlClient.SqlClient;
        const { request } = yield* Transactions;
        yield* sql`CREATE TABLE lifetime_read_only (id int PRIMARY KEY)`;

        const exit = yield* Effect.exit(
          request(readOnly(sql`INSERT INTO lifetime_read_only VALUES (1)`))
        );

        assert.strictEqual(refusalOf(exit)?.reason, "transaction-control");
        assert.strictEqual(yield* countRows("lifetime_read_only"), 0);
      })
    );
  });

  it("the allowlist admits no transaction control and SET LOCAL only for timeouts", () => {
    for (const keyword of [
      "begin",
      "commit",
      "rollback",
      "savepoint",
      "release",
      "prepare",
      "do",
      "call",
      "reset",
      "discard",
      "start",
      "end",
      "abort",
    ]) {
      assert.isFalse(STATEMENT_KEYWORDS.has(keyword), keyword);
    }

    assert.deepStrictEqual([...TRANSACTION_SETTINGS].toSorted(), [
      "idle_in_transaction_session_timeout",
      "lock_timeout",
      "statement_timeout",
    ]);
    assert.deepStrictEqual([...READ_KEYWORDS].toSorted(), [
      "select",
      "show",
      "table",
      "values",
      "with",
    ]);
  });

  layer(testDatabaseLayer({ maxConnections: 1 }), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "a dying scope finalizer rolls back and leaves the one pooled connection clean",
      () =>
        Effect.gen(function* dyingFinalizer() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE lifetime_finalizer (id int PRIMARY KEY)`;

          const exit = yield* Effect.exit(
            request(
              sql`INSERT INTO lifetime_finalizer VALUES (1)`.pipe(
                Effect.andThen(
                  Effect.addFinalizer(() =>
                    Effect.die(new Error("the finalizer fails"))
                  )
                )
              )
            )
          );

          assert.isTrue(exit._tag === "Failure");
          yield* request(sql`INSERT INTO lifetime_finalizer VALUES (2)`);

          const [idle] = yield* sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'idle in transaction'`.pipe(
            Effect.flatMap(decodeCount)
          );

          const rows =
            yield* sql`SELECT id FROM lifetime_finalizer ORDER BY id`;

          assert.strictEqual(idle?.n, 0);
          assert.deepStrictEqual(rows, [{ id: 2 }]);
        })
    );

    dbTest.effect(
      "a failed COMMIT discards the connection instead of reusing it",
      () =>
        Effect.gen(function* failedCommit() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`
            CREATE TABLE lifetime_deferred (
              id int CONSTRAINT lifetime_deferred_id UNIQUE DEFERRABLE INITIALLY DEFERRED
            )`;

          const before = yield* backendPid;

          const failure = errorOf(
            yield* Effect.exit(
              request(
                sql`INSERT INTO lifetime_deferred VALUES (1), (1)`.pipe(
                  Effect.asVoid
                )
              )
            )
          );

          const after = yield* backendPid;

          assert.instanceOf(failure, DatabaseError);
          assert.strictEqual(
            failure instanceof DatabaseError ? failure.sqlState : "",
            "23505"
          );
          assert.notStrictEqual(after, before, "a new connection");
        })
    );
  });
});
