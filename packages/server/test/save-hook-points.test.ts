/**
 * The pipeline around its seams (Contracts 2.3, 3.9, 4.1, 4.2): values from
 * before-write hooks are validated like body values, fields they add pass
 * the existing-state check, a hook that restores a value makes the save a
 * no-op again, one operation ID per transaction, and the allow-all
 * projection shows only the endpoint's fields.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { NotAllowed } from "@std/api/errors/not-allowed";
import type { DefinitionId } from "@std/definitions/ids";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import type { DecodedInput } from "@std/values/field-value";
import { Effect, Ref } from "effect";

import { SaveHooks } from "../src/records/save-hooks.ts";
import type { BeforeWriteInput } from "../src/records/save-hooks.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import type { ExistingActionCheck } from "../src/records/write-access.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  changeLog,
  recordsTestLayer,
  rootVersion,
  setUpAcme,
} from "./records-support.ts";
import { ACME, freshId, values } from "./schema-support.ts";

type Rewrite = (
  input: BeforeWriteInput
) => ReadonlyMap<DefinitionId, DecodedInput>;

// Runs an effect with a before-write hook that rewrites the values.
const withHook =
  (rewrite: Rewrite) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* hooked() {
      const hooks = yield* SaveHooks;

      return yield* Effect.provideService(effect, SaveHooks, {
        ...hooks,
        beforeWrite: (input) => Effect.succeed(rewrite(input)),
      });
    });

const setting =
  (fieldId: DefinitionId, value: DecodedInput): Rewrite =>
  (input) =>
    new Map([...input.values, [fieldId, value]]);

// An existing-state check that records its input and refuses `status`.
const refuseStatus =
  (checks: Ref.Ref<readonly ExistingActionCheck[]>) =>
  (input: ExistingActionCheck) =>
    Ref.update(checks, (seen) => [...seen, input]).pipe(
      Effect.andThen(
        input.written.has(ACME.status)
          ? Effect.fail(new NotAllowed())
          : Effect.void
      )
    );

const newLaptop = (name: string) =>
  createRecord({
    body: { name, purchased_on: "2026-01-15", serial: `SN-${name}` },
    endpointClassId: ACME.laptop,
  });

const operationIds = (ids: readonly string[]) =>
  values(
    `SELECT DISTINCT operation_id::text AS value FROM core."change"
     WHERE record_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    [JSON.stringify(ids)]
  );

describe("save-hook-points", () => {
  it("rewrites only the named field", () => {
    const rewritten = setting(
      ACME.name,
      "x"
    )({
      classId: ACME.asset,
      existing: null,
      kind: "create",
      snapshot: ConfigSnapshot.empty({ changeSetId: freshId(), revision: 0 }),
      values: new Map([[ACME.status, "s"]]),
    });

    assert.deepStrictEqual([...rewritten.keys()], [ACME.status, ACME.name]);
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "hook values are validated under the effective schema, required included",
      () =>
        Effect.gen(function* hookValidation() {
          const tooLong = yield* createRecord({
            body: { name: "ok" },
            endpointClassId: ACME.asset,
          }).pipe(withHook(setting(ACME.name, "x".repeat(121))), Effect.flip);

          assert.deepStrictEqual(
            tooLong._tag === "ValidationFailed"
              ? tooLong.errors.map((error) => `${error.field}:${error._tag}`)
              : [],
            ["name:InvalidValue"]
          );

          const wrongKind = yield* createRecord({
            body: { name: "ok" },
            endpointClassId: ACME.asset,
          }).pipe(withHook(setting(ACME.status, 42)), Effect.flip);

          assert.strictEqual(wrongKind._tag, "ValidationFailed");

          const dropped = yield* newLaptop("dropped").pipe(
            withHook((input) => {
              const rest = new Map(input.values);
              rest.delete(ACME.purchasedOn);

              return rest;
            }),
            Effect.flip
          );

          assert.deepStrictEqual(
            dropped._tag === "ValidationFailed" ? dropped.errors : [],
            [{ _tag: "Required", field: "purchased_on" }]
          );

          const laptop = yield* newLaptop("hook-update");

          const updateTooLong = yield* updateRecord({
            body: { name: "renamed" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(withHook(setting(ACME.serial, "s".repeat(65))), Effect.flip);

          assert.deepStrictEqual(
            updateTooLong._tag === "ValidationFailed"
              ? updateTooLong.errors.map((error) => error.field)
              : [],
            ["serial"]
          );
          assert.strictEqual(yield* rootVersion(laptop.id), 1);
        })
    );

    dbTest.effect(
      "fields a hook adds pass the existing-state check before any write",
      () =>
        Effect.gen(function* hookAddedFields() {
          const laptop = yield* newLaptop("hook-adds-status");
          const access = yield* WriteAccess;
          const checks = yield* Ref.make<readonly ExistingActionCheck[]>([]);

          const refusingStatus = {
            ...access,
            checkExisting: refuseStatus(checks),
          };

          const refused = yield* updateRecord({
            body: { name: "renamed" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(
            withHook(setting(ACME.status, "lost")),
            Effect.provideService(WriteAccess, refusingStatus),
            Effect.flip
          );

          assert.strictEqual(refused._tag, "NotAllowed");
          assert.deepStrictEqual(
            (yield* Ref.get(checks)).map((check) =>
              [...check.written].toSorted()
            ),
            [[ACME.name], [ACME.name, ACME.status].toSorted()]
          );
          assert.strictEqual(yield* rootVersion(laptop.id), 1);
          assert.deepStrictEqual(yield* changeLog(laptop.id), ["1:create"]);
        })
    );

    dbTest.effect("a hook that restores the stored value makes a no-op", () =>
      Effect.gen(function* restoredNoOp() {
        const laptop = yield* newLaptop("restored");

        const saved = yield* updateRecord({
          body: { name: "changed" },
          endpointClassId: ACME.laptop,
          expectedVersion: 1,
          id: laptop.id,
        }).pipe(withHook(setting(ACME.name, "restored")));

        assert.strictEqual(saved.outcome, "unchanged");
        assert.strictEqual(saved.version, 1);
        assert.deepStrictEqual(yield* changeLog(laptop.id), ["1:create"]);
      })
    );

    dbTest.effect("every save of one transaction shares its operation ID", () =>
      Effect.gen(function* operations() {
        const { request } = yield* Transactions;

        const [first, second] = yield* request(
          Effect.all([newLaptop("op-1"), newLaptop("op-2")])
        );

        const separate = yield* newLaptop("op-3");

        assert.lengthOf(yield* operationIds([first.id, second.id]), 1);
        assert.lengthOf(
          yield* operationIds([first.id, second.id, separate.id]),
          2
        );
      })
    );

    dbTest.effect(
      "the projection through a parent endpoint shows only its fields",
      () =>
        Effect.gen(function* projection() {
          const laptop = yield* newLaptop("projected");

          const saved = yield* updateRecord({
            body: { status: "spare" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          });

          const shown = saved.record?.values;

          assert.strictEqual(saved.record?.class, "acme.laptop");
          assert.isObject(shown);
          assert.notProperty(shown, "serial");
          assert.notProperty(shown, "disk_key");
          assert.property(shown, "status");
        })
    );
  });
});
