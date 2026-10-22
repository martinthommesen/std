/**
 * Operation IDs (Contracts 4.2: one per outermost transaction) and
 * write-only values from hooks (4.3, 6.5).
 *
 * - The operation ID is held per transaction attempt in TypeScript, so a
 *   caller's `set_config` can neither split nor forge it, and a retried
 *   config-commit attempt starts a new operation.
 * - Plaintext a before-write hook supplies is validated like body input.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { DefinitionId } from "@std/definitions/ids";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import type { DecodedInput } from "@std/values/field-value";
import { Plaintext } from "@std/values/write-only";
import { Deferred, Duration, Effect, Fiber, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { SaveHooks } from "../src/records/save-hooks.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { lockWaiting } from "../src/sql/statement-marks.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { recordsTestLayer, setUpAcme, TABLES } from "./records-support.ts";
import { ACME, values } from "./schema-support.ts";

// The `password` field of `core.user`.
const HASHED_FIELD_ID = "e122cfbe-11ea-4469-8c9b-14f4eab4aa74";

const newMonitor = (name: string) =>
  createRecord({ body: { name }, endpointClassId: ACME.monitor });

const operationIds = (ids: readonly string[]) =>
  values(
    `SELECT DISTINCT operation_id::text AS value FROM core."change"
     WHERE record_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    [JSON.stringify(ids)]
  );

const setOperation = (value: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`SELECT set_config('std.operation_id', ${value}, true)`
    )
  );

// Runs an effect with a before-write hook that sets one field of users
// (hooks follow the concrete class, Contracts 4.1; a user's create also
// creates its individual).
const withHookValue =
  (fieldId: DefinitionId, value: DecodedInput) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* hooked() {
      const hooks = yield* SaveHooks;

      return yield* Effect.provideService(effect, SaveHooks, {
        ...hooks,
        beforeWrite: (input) =>
          Effect.succeed(
            input.classId === USER_CLASS_ID
              ? new Map([...input.values, [fieldId, value]])
              : input.values
          ),
      });
    });

const fakeHasher = WriteOnlyValues.of({
  hashPassword: () => Effect.succeed("hashed"),
});

const createUser = (login: string, password: DecodedInput) =>
  createRecord({
    body: { login, name: login },
    endpointClassId: USER_CLASS_ID,
  }).pipe(
    withHookValue(HASHED_FIELD_ID, password),
    Effect.provideService(WriteOnlyValues, fakeHasher)
  );

const userCount = (login: string) =>
  values(`SELECT count(*)::text AS value FROM core."user" WHERE login = $1`, [
    login,
  ]).pipe(Effect.map(([count]) => Number(count)));

// One config-commit attempt: two saves, then a lock conflict on the first.
const attemptBody = (
  attempts: Ref.Ref<number>,
  seen: Ref.Ref<readonly (readonly string[])[]>,
  lockedId: string
) =>
  Effect.gen(function* attempt() {
    const index = yield* Ref.updateAndGet(attempts, (count) => count + 1);
    const first = yield* newMonitor(`retry-${index}-a`);
    const second = yield* newMonitor(`retry-${index}-b`);

    const shared = yield* operationIds([first.id, second.id]);

    assert.lengthOf(shared, 1);
    yield* Ref.update(seen, (all) => [...all, shared]);

    if (index === 1) {
      const sql = yield* SqlClient.SqlClient;

      yield* lockWaiting(
        sql.unsafe(
          `SELECT id FROM ${TABLES.asset} WHERE id = $1::uuid FOR UPDATE NOWAIT`,
          [lockedId]
        )
      );
    }

    return [first.id, second.id] as const;
  });

describe("save-operations", () => {
  it("never prints plaintext", () => {
    assert.strictEqual(String(new Plaintext("secret")), "<redacted>");
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "a caller's set_config neither splits nor forges the operation ID",
      () =>
        Effect.gen(function* forged() {
          const { request } = yield* Transactions;
          const forgedId = randomUUID();

          const [first, second] = yield* request(
            Effect.gen(function* twoSaves() {
              yield* setOperation(forgedId);
              const a = yield* newMonitor("forge-a");
              yield* setOperation("");
              const b = yield* newMonitor("forge-b");

              return [a, b] as const;
            })
          );

          const shared = yield* operationIds([first.id, second.id]);

          assert.lengthOf(shared, 1);
          assert.notInclude(shared, forgedId);
        })
    );

    dbTest.effect(
      "concurrent saves joined to one request share one operation ID",
      () =>
        Effect.gen(function* concurrent() {
          const { request } = yield* Transactions;

          const saved = yield* request(
            Effect.all(
              Array.from({ length: 6 }, (_, index) =>
                newMonitor(`concurrent-${index}`)
              ),
              { concurrency: "unbounded" }
            )
          );

          const shared = yield* operationIds(saved.map((record) => record.id));

          assert.lengthOf(shared, 1);
          assert.match(
            shared[0] ?? "",
            /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
          );
        })
    );

    dbTest.effect(
      "a retried config-commit attempt starts a new operation",
      () =>
        Effect.gen(function* retried() {
          const { configCommit, maintenance } = yield* Transactions;
          const target = yield* newMonitor("held");
          const locked = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();

          const holder = yield* maintenance(
            Effect.gen(function* holdRow() {
              const sql = yield* SqlClient.SqlClient;

              yield* sql.unsafe(
                `SELECT id FROM ${TABLES.asset} WHERE id = $1::uuid FOR UPDATE`,
                [target.id]
              );
              yield* Deferred.succeed(locked, true);
              yield* Deferred.await(release);
            })
          ).pipe(Effect.forkChild);

          yield* Deferred.await(locked);

          const attempts = yield* Ref.make(0);
          const seen = yield* Ref.make<readonly (readonly string[])[]>([]);

          const committed = yield* configCommit(
            attemptBody(attempts, seen, target.id),
            { retryDelays: [Duration.millis(10)] }
          );

          yield* Deferred.succeed(release, true);
          yield* Fiber.join(holder);

          const [firstAttempt, secondAttempt] = yield* Ref.get(seen);

          assert.strictEqual(yield* Ref.get(attempts), 2);
          assert.notStrictEqual(firstAttempt?.[0], secondAttempt?.[0]);
          assert.deepStrictEqual(yield* operationIds(committed), [
            secondAttempt?.[0] ?? "",
          ]);
        })
    );

    dbTest.effect(
      "hook plaintext is validated like body input and never stored when refused",
      () =>
        Effect.gen(function* plaintext() {
          for (const refusedText of ["", "a\u0000b", "\uD800"]) {
            const login = `refused-${randomUUID()}`;

            const refused = yield* createUser(
              login,
              new Plaintext(refusedText)
            ).pipe(Effect.flip);

            assert.deepStrictEqual(
              refused._tag === "ValidationFailed"
                ? refused.errors.map((error) => `${error.field}:${error._tag}`)
                : [refused._tag],
              ["password:InvalidValue"]
            );
            assert.strictEqual(yield* userCount(login), 0);
          }

          const login = `accepted-${randomUUID()}`;

          yield* createUser(login, new Plaintext("correct horse"));

          assert.strictEqual(yield* userCount(login), 1);
        })
    );
  });
});
