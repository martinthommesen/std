/**
 * The proposed-record stand-in (`proposedRelation`) decides field
 * readability exactly like the stored row it stands for (Contracts 3.8,
 * 3.9): for random values of every implemented field type, the fields the
 * caller can read on the stand-in equal those it can read on the record
 * inserted with the same values. Each field has a deny-read rule whose
 * condition reads that field, so a value bound differently in the stand-in
 * changes the outcome. JSON shaped like `{"set": true}` is ordinary JSON.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Condition } from "@std/definitions/condition";
import type { AccessTarget } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { decodeIn } from "@std/values/codec";
import type { FieldType } from "@std/values/field-type";
import type { DecodedInput } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer, Option, Ref } from "effect";
import {
  asyncProperty,
  boolean,
  check,
  constantFrom,
  integer,
  oneof,
  record,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import { Actor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { makeReadScope } from "../src/records/read-view.ts";
import type { ReadScope } from "../src/records/read-view.ts";
import {
  readableOnProposal,
  readableOnRecord,
} from "../src/records/record-access.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  addField,
  change,
  createClass,
  createRole,
  ensureSite,
  loadCore,
  schemaTestLayer,
  addAccessRule,
} from "./schema-support.ts";

const UUID_A = "0192f000-0000-7000-8000-00000000000a";
const UUID_B = "0192f000-0000-7000-8000-00000000000b";

/** One probed field: its type, its deny condition and its value pool. */
interface ProbeField {
  readonly name: string;
  readonly type: FieldType;
  /** The deny-read condition over the field's own path. */
  readonly deny: (path: { readonly path: readonly string[] }) => Condition;
  readonly values: Arbitrary<JsonValue>;
}

const greater =
  (value: JsonValue) =>
  (left: { readonly path: readonly string[] }): Condition => ({
    left,
    op: "gt",
    right: { value },
  });

const equal =
  (value: JsonValue) =>
  (left: { readonly path: readonly string[] }): Condition => ({
    left,
    op: "eq",
    right: { value },
  });

const notEmpty = (arg: { readonly path: readonly string[] }): Condition => ({
  arg,
  op: "notEmpty",
});

const PROBES: readonly ProbeField[] = [
  {
    deny: equal("a"),
    name: "f_text",
    type: { kind: "text" },
    values: constantFrom(null, "a", "A", "b"),
  },
  {
    deny: notEmpty,
    name: "f_long",
    type: { kind: "longText" },
    values: constantFrom(null, "", "x"),
  },
  {
    deny: greater(0),
    name: "f_int",
    type: { kind: "integer" },
    values: oneof(constantFrom(null), integer({ max: 3, min: -3 })),
  },
  {
    deny: greater("0"),
    name: "f_big",
    type: { kind: "bigInteger" },
    values: constantFrom(null, "-1", "0", "1", "9007199254740993"),
  },
  {
    deny: greater("50.00"),
    name: "f_dec",
    type: { kind: "decimal", precision: 10, scale: 2 },
    values: constantFrom(null, "-0", "49.99", "50.00", "50.01"),
  },
  {
    deny: equal(true),
    name: "f_bool",
    type: { kind: "boolean" },
    values: boolean(),
  },
  {
    deny: greater("2000-01-01"),
    name: "f_date",
    type: { kind: "date" },
    values: constantFrom(null, "1999-12-31", "2000-01-01", "2000-01-02"),
  },
  {
    deny: greater("2000-01-01T00:00:00.000Z"),
    name: "f_time",
    type: { kind: "dateTime" },
    values: constantFrom(
      null,
      "1999-12-31T23:59:59.999Z",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:00.001Z",
      "2000-01-01T01:00:00.000+01:00"
    ),
  },
  {
    deny: equal(UUID_A),
    name: "f_uuid",
    type: { kind: "uuid" },
    values: constantFrom(null, UUID_A, UUID_B, UUID_A.toUpperCase()),
  },
  {
    deny: equal(SYSTEM_USER_ID),
    name: "f_ref",
    type: { kind: "reference", targetClassId: USER_CLASS_ID },
    values: constantFrom(null, SYSTEM_USER_ID),
  },
  {
    deny: notEmpty,
    name: "f_json",
    type: { kind: "json" },
    values: constantFrom(
      null,
      { set: true },
      { set: false },
      { a: 1 },
      [],
      "x",
      0
    ),
  },
  {
    deny: notEmpty,
    name: "f_pass",
    type: { kind: "password" },
    values: constantFrom(null, "secret"),
  },
];

/** The probe class, its fields by name and the prober's role. */
interface ProbeSchema {
  readonly classId: string;
  readonly probes: readonly {
    readonly probe: ProbeField;
    readonly id: string;
  }[];
  readonly roleId: string;
}

const setUpProbes = Effect.gen(function* setUpProbes() {
  yield* loadCore;
  yield* ensureSite;

  const probeClass = createClass("probe_all");

  const fields = PROBES.map((probe) => ({
    field: addField(probeClass.id, probe.name, probe.type),
    probe,
  }));

  yield* change([
    probeClass.op,
    ...fields.map(({ field }) => field.op),
    createRole("prober"),
  ]);

  const snapshot = yield* (yield* Catalog).refresh;
  const roleId = snapshot.roleByName("prober")?.id ?? "";

  const rule = (
    effect: "allow" | "deny",
    target: AccessTarget,
    condition: Condition | null
  ): Operation =>
    addAccessRule(probeClass.id, [roleId], {}, { condition, effect, target })
      .op;

  yield* change([
    rule("allow", { kind: "records" }, null),
    rule("allow", { fields: "*", kind: "fields" }, null),
    ...fields.map(({ probe, field }) =>
      rule(
        "deny",
        { fields: [field.id], kind: "fields" },
        probe.deny({ path: [field.id] })
      )
    ),
  ]);

  return {
    classId: probeClass.id,
    probes: fields.map(({ probe, field }) => ({ id: field.id, probe })),
    roleId,
  } satisfies ProbeSchema;
});

const SeedServices = Layer.mergeAll(
  WriteAccess.allowAll,
  SaveHooks.none,
  Layer.succeed(
    WriteOnlyValues,
    WriteOnlyValues.of({ hashPassword: () => Effect.succeed("hashed") })
  ),
  Layer.succeed(Actor, Actor.of({ roleIds: [], userId: SYSTEM_USER_ID }))
);

type Sample = Readonly<Record<string, JsonValue>>;

const sampleArb: Arbitrary<Sample> = record(
  Object.fromEntries(PROBES.map((probe) => [probe.name, probe.values]))
);

const inputs = (schema: ProbeSchema, sample: Sample) => {
  const values = new Map<string, DecodedInput>();

  for (const { probe, id } of schema.probes) {
    const decoded = decodeIn(probe.type, sample[probe.name] ?? null);

    if (!decoded.ok) {
      throw new RangeError(`Sample value of ${probe.name} is invalid`);
    }

    values.set(id, decoded.value);
  }

  return values;
};

const scopeOf = (scopeSnapshot: ReadScope["snapshot"], roleId: string) =>
  makeReadScope(
    scopeSnapshot,
    { roleIds: [roleId] },
    { me: SYSTEM_USER_ID, now: Date.now(), timeZone: "UTC" }
  );

/** Readability on the stand-in and on the inserted row, as sorted names. */
const compare = Effect.fn("ProposedRelation.compare")(function* compare(
  schema: ProbeSchema,
  sample: Sample
) {
  const snapshot = yield* (yield* Catalog).current;
  const scope = scopeOf(snapshot, schema.roleId);

  const standIn = yield* readableOnProposal(scope, {
    actorId: SYSTEM_USER_ID,
    classId: schema.classId,
    existing: null,
    values: inputs(schema, sample),
  });

  const saved = yield* createRecord({
    body: sample,
    endpointClassId: schema.classId,
  }).pipe(Effect.provide(SeedServices));

  const stored = yield* readableOnRecord(scope, schema.classId, saved.id);

  const names = (ids: ReadonlySet<string>) =>
    schema.probes.flatMap(({ probe, id }) => (ids.has(id) ? [probe.name] : []));

  return {
    standIn: names(standIn),
    stored: names(Option.getOrElse(stored, () => new Set<string>())),
  };
});

type Services = Transactions | Catalog;

const checkSamples = async (
  run: (effect: Effect.Effect<boolean, unknown, Services>) => Promise<boolean>,
  schema: ProbeSchema,
  hidden: Ref.Ref<number>
) =>
  await check(
    asyncProperty(
      sampleArb,
      async (sample) =>
        await run(
          Effect.gen(function* sampleAgrees() {
            const { request } = yield* Transactions;
            const outcome = yield* request(compare(schema, sample));

            yield* Ref.update(
              hidden,
              (count) => count + PROBES.length - outcome.stored.length
            );

            return (
              JSON.stringify(outcome.standIn) === JSON.stringify(outcome.stored)
            );
          })
        )
    ),
    { numRuns: 40 }
  );

describe("proposed-relation", () => {
  it("probes every implemented field type", () => {
    assert.lengthOf(
      new Set(PROBES.map((probe) => probe.type.kind)),
      PROBES.length
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the stand-in and the inserted row give the same field readability",
      () =>
        Effect.gen(function* sameReadability() {
          const schema = yield* setUpProbes;
          const { request } = yield* Transactions;

          const jsonLikeSecret = yield* request(
            compare(schema, {
              f_bool: false,
              f_json: { set: true },
            })
          );

          assert.notInclude(jsonLikeSecret.standIn, "f_json");
          assert.deepStrictEqual(jsonLikeSecret.standIn, jsonLikeSecret.stored);

          const services = yield* Effect.context<Services>();
          const run = Effect.runPromiseWith(services);
          const hidden = yield* Ref.make(0);

          const result = yield* Effect.promise(
            async () => await checkSamples(run, schema, hidden)
          );

          assert.isFalse(
            result.failed,
            `counterexample ${JSON.stringify(result.counterexample)} (seed ${result.seed})`
          );
          assert.isAbove(yield* Ref.get(hidden), 0, "some fields were hidden");
        })
    );
  });
});
