/**
 * Review round 1 reproductions: raw Postgres text must not escape through a
 * defect, a wrapping error or a statement outside a transaction.
 */
import { inspect } from "node:util";

import { assert, describe, it, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError, UnknownError } from "effect/sql/SqlError";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import {
  DatabaseError,
  isSanitized,
  sanitizeCause,
  sanitizeSqlError,
  sqlStateOf,
} from "../src/sql/errors.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { errorOf } from "./support.ts";

const PRIVATE = "private-value";

/** A caller error that wraps a statement error, as application code might. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class WrappedFailure extends Schema.TaggedError<WrappedFailure>()(
  "WrappedFailure",
  { cause: Schema.Defect() }
) {}

/**
 * Everything a caller could print about an exit.
 * @param exit - Any exit.
 * @returns Pretty cause, inspected cause and JSON of the cause.
 */
const renderings = <A, E>(exit: Exit.Exit<A, E>): readonly string[] =>
  Exit.isFailure(exit)
    ? [
        Cause.pretty(exit.cause),
        inspect(exit.cause, { depth: 20 }),
        JSON.stringify(exit.cause.reasons),
      ]
    : [];

const assertNoPrivateText = <A, E>(exit: Exit.Exit<A, E>): void => {
  assert.isTrue(Exit.isFailure(exit));

  for (const rendered of renderings(exit)) {
    assert.notInclude(rendered, PRIVATE);
    assert.notInclude(rendered, "invalid input syntax");
  }
};

describe("error-hygiene", () => {
  it("a sanitized error keeps its kind, SQLSTATE and constraint only", () => {
    const raw = new SqlError({
      reason: new UnknownError({
        cause: Object.assign(new Error(`bad ${PRIVATE}`), {
          code: "22P02",
          detail: PRIVATE,
        }),
        message: `bad ${PRIVATE}`,
        operation: "query",
      }),
    });

    const safe = sanitizeSqlError(raw);

    assert.isTrue(isSanitized(safe));
    assert.strictEqual(sanitizeSqlError(raw), safe, "one twin per error");
    assert.strictEqual(sanitizeSqlError(safe), safe);
    assert.strictEqual(sqlStateOf(safe), "22P02");
    assert.strictEqual(safe.message, "Database error 22P02");
    assert.notInclude(inspect(safe, { depth: 20 }), PRIVATE);
  });

  it.effect(
    "sanitizeCause turns SqlError failures and defects into DatabaseError",
    () =>
      Effect.gen(function* edgeFallback() {
        const raw = new SqlError({
          reason: new UnknownError({
            cause: Object.assign(new Error(PRIVATE), { code: "XX001" }),
            message: PRIVATE,
          }),
        });

        const cause = yield* sanitizeCause(
          Cause.combine(Cause.fail(raw), Cause.die(raw))
        );

        for (const reason of cause.reasons) {
          if (Cause.isFailReason(reason)) {
            assert.instanceOf(reason.error, DatabaseError);
          }

          if (Cause.isDieReason(reason)) {
            assert.instanceOf(reason.defect, DatabaseError);
          }
        }

        assert.notInclude(inspect(cause, { depth: 20 }), PRIVATE);
      })
  );

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a statement error turned into a defect inside a request leaves no Postgres text",
      () =>
        Effect.gen(function* orDieInsideRequest() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;

          const exit = yield* Effect.exit(
            request(sql`SELECT 'private-value'::int`.pipe(Effect.orDie))
          );

          assertNoPrivateText(exit);
        })
    );

    dbTest.effect(
      "a statement error wrapped by the caller leaves no Postgres text",
      () =>
        Effect.gen(function* wrappedInsideRequest() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;

          const exit = yield* Effect.exit(
            request(
              sql`SELECT 'private-value'::int`.pipe(
                Effect.mapError(
                  (failure) => new WrappedFailure({ cause: failure })
                )
              )
            )
          );

          assertNoPrivateText(exit);
          assert.instanceOf(errorOf(exit), WrappedFailure);
        })
    );

    dbTest.effect(
      "statements outside transactions are sanitized at the statement",
      () =>
        Effect.gen(function* outsideTransactions() {
          const sql = yield* SqlClient.SqlClient;
          const exit = yield* Effect.exit(sql`SELECT 'private-value'::int`);
          const failure = errorOf(exit);

          assertNoPrivateText(exit);
          assert.instanceOf(failure, SqlError);
          assert.isTrue(failure !== undefined && isSanitized(failure));
          assert.strictEqual(
            failure === undefined ? "" : sqlStateOf(failure),
            "22P02"
          );
        })
    );

    dbTest.effect(
      "DatabaseError carries the id of the log entry with the raw fields",
      () =>
        Effect.gen(function* diagnosticId() {
          const sql = yield* SqlClient.SqlClient;
          const { request } = yield* Transactions;

          const failure = errorOf(
            yield* Effect.exit(request(sql`SELECT 'private-value'::int`))
          );

          assert.instanceOf(failure, DatabaseError);
          assert.match(
            failure instanceof DatabaseError
              ? (failure.diagnosticId ?? "")
              : "",
            /^[\da-f]{16}$/u
          );
        })
    );
  });
});
