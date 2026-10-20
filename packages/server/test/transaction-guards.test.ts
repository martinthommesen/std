/**
 * Review round 1 reproductions: transaction control hidden by comments or
 * punctuation, writes hidden from text inference, fibers outliving their
 * transaction, and use of a transaction after it ended.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { readOnly } from "../src/sql/statement-marks.ts";
import { CurrentTransaction } from "../src/sql/transaction-context.ts";
import { refusalFor } from "../src/sql/transaction-state.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { refusalOf } from "./support.ts";

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const countRows = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)
    ),
    Effect.flatMap(decodeCount),
    Effect.map(([row]) => row?.n ?? -1)
  );

const REFUSED: readonly (readonly [string, string | undefined])[] = [
  [";COMMIT", "transaction-control"],
  ["; COMMIT", "transaction-control"],
  ["-- comment\rCOMMIT", "transaction-control"],
  ["-- comment\r\nCOMMIT", "transaction-control"],
  ["SELECT 1;", "transaction-control"],
  ["SELECT 1; -- trailing comment", "transaction-control"],
  ["", "transaction-control"],
  ["-- only a comment", "transaction-control"],
  ["DO $$ BEGIN COMMIT; END $$", "transaction-control"],
  ["CALL some_procedure()", "transaction-control"],
  ["DISCARD ALL", "transaction-control"],
  ["PREPARE p AS SELECT 1", "transaction-control"],
  ["TRUNCATE t", "transaction-control"],
  ["SET lock_timeout = '1s'", "transaction-control"],
  ["SET SESSION statement_timeout = 0", "transaction-control"],
  ["SET LOCAL search_path = public", "transaction-control"],
  ["SET LOCAL \"lock_timeout\" = '1s'", undefined],
  ["SET LOCAL U&\"transaction_\\0069solation\" = 'serializable'", undefined],
  ["COMMIT;", "transaction-control"],
  ["commit", "transaction-control"],
  ["  -- comment\n  Commit", "transaction-control"],
  ["/* a /* nested */ comment */COMMIT", "transaction-control"],
  ["BEGIN/*comment*/ ISOLATION LEVEL REPEATABLE READ", "transaction-control"],
  ["start transaction", "transaction-control"],
  ["END", "transaction-control"],
  ["abort", "transaction-control"],
  ["ROLLBACK", "transaction-control"],
  ["COMMIT PREPARED 'x'", "transaction-control"],
  ["PREPARE TRANSACTION 'x'", "transaction-control"],
  ["SAVEPOINT/*comment*/ my_sp", "savepoint"],
  ["release my_sp", "savepoint"],
  ["ROLLBACK TO SAVEPOINT my_sp", "savepoint"],
  ["rollback/**/to my_sp", "savepoint"],
  ["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "isolation-level"],
  ["set local transaction read only", "isolation-level"],
  [
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    "isolation-level",
  ],
  ["SET default_transaction_isolation TO serializable", "isolation-level"],
  [
    "set session default_transaction_isolation = 'serializable'",
    "isolation-level",
  ],
  ["SET \"transaction_isolation\" = 'serializable'", "isolation-level"],
  ["RESET ALL", "transaction-control"],
  ["SELECT 1; COMMIT", "transaction-control"],
  ["SELECT 1;SELECT 2", "transaction-control"],
  ["SELECT '\\';COMMIT'", "transaction-control"],
];

const ALLOWED: readonly string[] = [
  "SELECT 1",
  "SELECT 1 -- trailing comment",
  "SET LOCAL statement_timeout TO 0",
  "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  "UPDATE t SET a = 1",
  "DELETE FROM t",
  "CREATE TABLE t (id int)",
  "ALTER TABLE t ADD COLUMN b int",
  "COMMENT ON TABLE t IS 'x'",
  "LOCK TABLE t IN SHARE MODE",
  "SELECT U&'d\\0061t\\+000061'",
  "SELECT 'a;b'",
  "SELECT E'\\';commit'",
  "SELECT $$;COMMIT$$",
  "SELECT $tag$ $$ ; COMMIT $tag$",
  'SELECT "commit;" FROM t',
  "SELECT $1::int",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "SET LOCAL lock_timeout = '1s'",
  "INSERT INTO t VALUES (1)",
  "SELECT 1 /* ; COMMIT */",
];

const blockForever = Effect.sleep(Duration.minutes(5));

/**
 * An outer unit that writes, runs `statement` in a nested unit that then
 * fails, and catches that failure.
 * @param statement - The nested unit's statement.
 * @returns The outer request.
 */
const outerCatchesNested = (
  statement: Effect.Effect<unknown, unknown, SqlClient.SqlClient>
) =>
  Effect.gen(function* outerUnit() {
    const sql = yield* SqlClient.SqlClient;
    const { request } = yield* Transactions;

    const failingNested = request(
      statement.pipe(Effect.andThen(Effect.fail("nested" as const)))
    );

    return yield* request(
      sql`INSERT INTO guard_writes VALUES (1, 'outer')`.pipe(
        Effect.andThen(failingNested.pipe(Effect.ignore))
      )
    );
  });

/** How a test forks the writer: `Effect.forkChild` or `Effect.forkScoped`. */
type Fork = (
  child: Effect.Effect<void, unknown, SqlClient.SqlClient>
) => Effect.Effect<unknown, never, Scope.Scope | SqlClient.SqlClient>;

/**
 * A request whose body forks a nested unit that writes, signals and then
 * blocks; the body returns as soon as the write happened.
 * @param fork - How to fork the nested unit.
 * @returns The request.
 */
const forkWriterThatOutlivesBody = (fork: Fork) =>
  Effect.gen(function* forkWriter() {
    const sql = yield* SqlClient.SqlClient;
    const { request } = yield* Transactions;
    const wrote = yield* Deferred.make<boolean>();

    const writer = request(
      sql`INSERT INTO guard_child VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(wrote, true)),
        Effect.andThen(blockForever),
        Effect.andThen(Effect.fail("late failure" as const))
      )
    ).pipe(Effect.ignore);

    return yield* request(
      fork(writer).pipe(Effect.andThen(Deferred.await(wrote)))
    );
  });

describe("transaction-guards", () => {
  it("lexes the leading keywords: comments, punctuation and quoting cannot hide control statements", () => {
    for (const [sql, reason] of REFUSED) {
      const refused = refusalFor(sql);

      assert.isDefined(refused, sql);

      if (reason !== undefined) {
        assert.strictEqual(refused?.[0], reason, sql);
      }
    }

    for (const sql of ALLOWED) {
      assert.isUndefined(refusalFor(sql), sql);
    }
  });

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "COMMIT; inside a request is refused and nothing commits",
      () =>
        Effect.gen(function* commitHidden() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;
          yield* sql`CREATE TABLE guard_commit (id int PRIMARY KEY)`;

          const exit = yield* Effect.exit(
            request(
              Effect.gen(function* insertCommitFail() {
                yield* sql`INSERT INTO guard_commit VALUES (1)`;
                yield* sql.unsafe("COMMIT;");
                yield* sql.unsafe(
                  "BEGIN/*comment*/ ISOLATION LEVEL REPEATABLE READ"
                );

                return yield* Effect.fail("then fail" as const);
              })
            )
          );

          assert.strictEqual(refusalOf(exit)?.reason, "transaction-control");
          assert.strictEqual(yield* countRows("guard_commit"), 0);

          const savepoint = yield* Effect.exit(
            request(sql.unsafe("SAVEPOINT/*comment*/ my_sp"))
          );

          assert.strictEqual(refusalOf(savepoint)?.reason, "savepoint");
        })
    );

    dbTest.effect(
      "every statement of a nested unit counts as a potential write unless marked readOnly",
      () =>
        Effect.gen(function* hiddenWrites() {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE guard_writes (id int PRIMARY KEY, note text)`;
          yield* sql`
            CREATE FUNCTION probe_write() RETURNS int LANGUAGE sql VOLATILE AS
            $$ INSERT INTO guard_writes VALUES (100, 'from a function') RETURNING id $$`;

          const longCte = `WITH x AS (SELECT '${"x".repeat(550)}' AS note)
            INSERT INTO guard_writes SELECT 2, note FROM x`;

          const cte = yield* Effect.exit(
            outerCatchesNested(sql.unsafe(longCte))
          );

          assert.strictEqual(refusalOf(cte)?.reason, "poisoned");

          const writingSelect = yield* Effect.exit(
            outerCatchesNested(sql`SELECT probe_write()`)
          );

          assert.strictEqual(refusalOf(writingSelect)?.reason, "poisoned");
          assert.strictEqual(yield* countRows("guard_writes"), 0);

          yield* outerCatchesNested(
            readOnly(sql`SELECT count(*) FROM guard_writes`)
          );
          assert.strictEqual(yield* countRows("guard_writes"), 1);
        })
    );

    dbTest.effect(
      "a forked child that wrote and outlives the body poisons the transaction instead of committing",
      () =>
        Effect.gen(function* childOutlivesBody() {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE guard_child (id int PRIMARY KEY)`;

          const child = yield* Effect.exit(
            forkWriterThatOutlivesBody(Effect.forkChild)
          );

          assert.strictEqual(refusalOf(child)?.reason, "poisoned");

          const scoped = yield* Effect.exit(
            forkWriterThatOutlivesBody(Effect.forkScoped)
          );

          assert.strictEqual(refusalOf(scoped)?.reason, "poisoned");
          assert.strictEqual(yield* countRows("guard_child"), 0);
        })
    );

    dbTest.effect(
      "a transaction's handle, connection and nesting are refused after it ends",
      () =>
        Effect.gen(function* closedHandle() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;

          const captured = yield* request(
            Effect.context<CurrentTransaction | SqlClient.SqlClient>()
          );

          const handle = yield* Effect.provideContext(
            CurrentTransaction,
            captured
          );

          const register = yield* Effect.exit(handle.afterCommit(Effect.void));
          assert.strictEqual(refusalOf(register)?.reason, "closed");

          const statement = yield* Effect.exit(
            Effect.provideContext(sql`SELECT 1 AS one`, captured)
          );

          assert.strictEqual(refusalOf(statement)?.reason, "closed");

          const joined = yield* Effect.exit(
            Effect.provideContext(request(sql`SELECT 1 AS one`), captured)
          );

          assert.strictEqual(refusalOf(joined)?.reason, "closed");
        })
    );
  });
});
