/**
 * Deadlocks and serialization failures at the HTTP edge (Contracts 3.8):
 * Postgres rolled the whole request transaction back, so the work runs again
 * in a new transaction instead of answering an empty 500. Other database
 * errors are not retried.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { HttpServerRequest } from "effect/http";

import {
  inRequestTransaction,
  isTransientFailure,
  TRANSIENT_RETRIES,
} from "../src/http/request-scope.ts";
import { DatabaseError } from "../src/sql/errors.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { schemaTestLayer, values } from "./schema-support.ts";

const requestOf = () =>
  HttpServerRequest.fromWeb(new Request("http://std.test/api/v1/x"));

// Work that fails with `sqlState` for its first `failures` attempts.
const failingFirst = (
  attempts: Ref.Ref<number>,
  failures: number,
  sqlState: string
) =>
  Effect.gen(function* attempt() {
    const count = yield* Ref.updateAndGet(attempts, (n) => n + 1);

    // A statement in the transaction, so each attempt is a real one.
    yield* values("SELECT 'ok' AS value");

    if (count <= failures) {
      return yield* new DatabaseError({ sqlState });
    }

    return count;
  });

describe("transient-retry", () => {
  it("treats deadlocks and serialization failures as transient, nothing else", () => {
    assert.isTrue(isTransientFailure(new DatabaseError({ sqlState: "40P01" })));
    assert.isTrue(isTransientFailure(new DatabaseError({ sqlState: "40001" })));
    assert.isFalse(
      isTransientFailure(new DatabaseError({ sqlState: "23505" }))
    );
    assert.isFalse(
      isTransientFailure(new DatabaseError({ sqlState: "55P03" }))
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a deadlock or serialization failure runs the request again",
      () =>
        Effect.gen(function* retried() {
          const transactions = yield* Transactions;

          for (const sqlState of ["40P01", "40001"]) {
            const attempts = yield* Ref.make(0);

            const result = yield* inRequestTransaction(
              transactions,
              requestOf(),
              failingFirst(attempts, 2, sqlState)
            );

            assert.strictEqual(result, 3);
          }
        })
    );

    dbTest.effect(
      "retries are bounded, and other database errors are not retried",
      () =>
        Effect.gen(function* bounded() {
          const transactions = yield* Transactions;
          const deadlocks = yield* Ref.make(0);

          const exhausted = yield* Effect.exit(
            inRequestTransaction(
              transactions,
              requestOf(),
              failingFirst(deadlocks, 100, "40P01")
            )
          );

          assert.isTrue(Exit.isFailure(exhausted));
          assert.strictEqual(yield* Ref.get(deadlocks), TRANSIENT_RETRIES + 1);

          const unique = yield* Ref.make(0);

          const refused = yield* Effect.exit(
            inRequestTransaction(
              transactions,
              requestOf(),
              failingFirst(unique, 100, "23505")
            )
          );

          assert.isTrue(Exit.isFailure(refused));
          assert.strictEqual(yield* Ref.get(unique), 1);
        })
    );
  });
});
