/**
 * Aggregates on `/api/v1` (Contracts 4.9, 10; decision 0029):
 *
 * - an owner reference shows in the table metadata as `aggregate: true` on
 *   its reference type, and an aggregate that does not settle answers `422`
 *   with the TMF Error shape of `AggregateNotSettled`, which the contract
 *   checker validates against the declared errors;
 * - an owner reference is required, and writing a different owner into it
 *   is `ReadOnlyField`;
 * - a second owner reference, a cycle and a fourth level are refused
 *   through `applyChangeSet` with their own problem codes;
 * - a system write that settling persists names in its errors only fields
 *   the caller can read on the proposed record: a reader learns the field,
 *   a caller who cannot read it gets `ValidationFailed` naming none.
 *
 * The race over `/api/v1` and TMF621 is the follow-up
 * `aggregate-race-http` (decision 0029).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { TmfErrorSubtypes } from "@std/api/tmf-error";
import type { AccessTarget } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { API, apiCallers, asArray, asObject, textOf } from "./api-support.ts";
import { codeOf, readsTestLayer } from "./reads-support.ts";
import { postChangeSet } from "./schema-paths-support.ts";
import {
  ACME,
  addField,
  addRecordRule,
  change,
  createClass,
  createNamespace,
  freshId,
} from "./schema-support.ts";
import { create, patch, savedOf } from "./writes-support.ts";

const NAMESPACE = createNamespace("agapi");
const BOX = createClass("agapi_box", { namespaceId: NAMESPACE.id });
const ITEM = createClass("agapi_item", { namespaceId: NAMESPACE.id });
const BOX_COUNT = addField(BOX.id, "count", { kind: "integer" });

const ITEM_BOX = addField(ITEM.id, "box", {
  aggregate: true,
  kind: "reference",
  targetClassId: BOX.id,
});

const ITEM_COUNT = addField(ITEM.id, "count", { kind: "integer" });

// Never settles once a box has an item: it changes both every pass.
const LOOP = addRecordRule(BOX.id, {
  actions: [
    {
      type: "set",
      values: [{ fieldId: BOX_COUNT.id, value: { increment: BOX_COUNT.id } }],
    },
    {
      classId: ITEM.id,
      type: "setParts",
      values: [
        {
          fieldId: ITEM_COUNT.id,
          value: { copy: { fieldId: BOX_COUNT.id, from: "owner" } },
        },
      ],
      where: null,
    },
  ],
  condition: { class: ITEM.id, op: "anyPart", where: { op: "true" } },
  operations: [],
  phase: "aggregate",
  ruleKind: null,
});

/** acme's `asset_manager` and `employee` roles. */
const ACME_ROLES = [
  "081e3ce8-26a8-43a2-bc58-838d40b4c22d",
  "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b",
];

/** acme.asset's `docked_to`, which Bob cannot read on an asset over 2000. */
const DOCKED_TO = "83ec3835-6898-46f3-ae2e-afdbc3f5d407";

/** An asset ID no record has. */
const ABSENT_ASSET = "00000000-0000-4000-8000-0000000000ab";

// A part class of acme.asset, which Alice and Bob may write.
const PART_NAMESPACE = createNamespace("agapi_parts");
const PART = createClass("agapi_part", { namespaceId: PART_NAMESPACE.id });

const PART_ASSET = addField(PART.id, "asset", {
  aggregate: true,
  kind: "reference",
  targetClassId: ACME.asset,
});

const PART_NOTE = addField(PART.id, "note", { kind: "text", maxLength: 40 });

/** The part class's qualified name. */
const PARTS = "agapi_parts.agapi_part";

/**
 * A class of the parts' namespace.
 * @param name - Its name.
 * @returns The operation and the class ID.
 */
const partsClass = (name: string) =>
  createClass(name, { namespaceId: PART_NAMESPACE.id });

/**
 * An owner reference from one class to another.
 * @param part - The part class.
 * @param whole - The owner class.
 * @returns The operation.
 */
const ownedBy = (
  part: { readonly id: string },
  whole: { readonly id: string }
): Operation =>
  addField(part.id, "owner", {
    aggregate: true,
    kind: "reference",
    targetClassId: whole.id,
  }).op;

/**
 * An access rule letting acme's roles read, create and update parts.
 * @param target - Records or fields.
 * @returns The operation.
 */
const partAccess = (target: AccessTarget): Operation => ({
  definition: {
    actions: ["read", "create", "update"],
    active: true,
    classId: PART.id,
    condition: null,
    description: "acme's roles may write parts",
    effect: "allow",
    id: freshId(),
    kind: "accessRule",
    name: null,
    owner: { layer: "local" },
    protected: false,
    roleIds: ACME_ROLES,
    target,
  },
  op: "createAccessRule",
});

// A system write the caller's own write could not make: settling sets
// docked_to to an asset that does not exist.
const BAD_DOCK = addRecordRule(ACME.asset, {
  actions: [
    {
      type: "set",
      values: [{ fieldId: DOCKED_TO, value: { value: ABSENT_ASSET } }],
    },
  ],
  condition: {
    class: PART.id,
    op: "anyPart",
    where: {
      left: { path: [PART_NOTE.id] },
      op: "eq",
      right: { value: "bad-dock" },
    },
  },
  operations: [],
  phase: "aggregate",
  ruleKind: null,
});

/**
 * The entry of a JSON array whose member has a value.
 * @param list - A JSON array.
 * @param member - The member's name.
 * @param value - Its value.
 * @returns The entry, or an empty object.
 */
const entryWith = (
  list: JsonValue | undefined,
  member: string,
  value: string
): JsonObject =>
  asArray(list)
    .map(asObject)
    .find((entry) => entry[member] === value) ?? {};

/**
 * The `field:_tag` pairs of a refusal's `fieldErrors`.
 * @param json - The error body.
 * @returns The pairs.
 */
const fieldErrorsOf = (json: JsonValue | undefined): string[] =>
  asArray(asObject(json).fieldErrors).map((error) => {
    const { _tag: tag, field } = asObject(error);

    return `${textOf(field)}:${textOf(tag)}`;
  });

/**
 * The problem codes of a `DefinitionInvalid` refusal.
 * @param json - The error body.
 * @returns The codes.
 */
const problemCodesOf = (json: JsonValue | undefined): string[] =>
  asArray(asObject(json).problems).map((problem) =>
    textOf(asObject(problem).code)
  );

describe("aggregate-api", () => {
  it("declares AggregateNotSettled as an error subtype", () => {
    assert.strictEqual(new AggregateNotSettled()._tag, "AggregateNotSettled");
    assert.property(TmfErrorSubtypes, "AggregateNotSettled");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an owner reference shows in the table metadata, and an aggregate that does not settle is a 422 TMF Error",
      () =>
        Effect.gen(function* apiAggregates() {
          yield* change([
            NAMESPACE.op,
            BOX.op,
            ITEM.op,
            BOX_COUNT.op,
            ITEM_BOX.op,
            ITEM_COUNT.op,
          ]);
          yield* change([LOOP.op]);

          const http = yield* TestHttpClient;
          const { admin } = yield* apiCallers;

          const listed = yield* http.get("/api/v1/tableMetadata", admin);

          const item = entryWith(listed.json, "label", "agapi_item").id;
          const box = entryWith(listed.json, "label", "agapi_box").id;

          const metadata = yield* http.get(
            `/api/v1/tableMetadata/${textOf(item)}`,
            admin
          );

          const owner = entryWith(
            asObject(metadata.json).fields,
            "name",
            "box"
          );

          assert.strictEqual(metadata.status, 200, metadata.text);
          assert.strictEqual(asObject(owner.type).aggregate, true);
          assert.strictEqual(owner.required, true);

          const created = yield* http.request(
            "POST",
            `/api/v1/${textOf(box)}`,
            {
              ...admin,
              body: { count: 0 },
            }
          );

          assert.strictEqual(created.status, 201, created.text);

          const refused = yield* http.request(
            "POST",
            `/api/v1/${textOf(item)}`,
            {
              ...admin,
              body: {
                box: { id: textOf(asObject(created.json).id) },
                count: 0,
              },
            }
          );

          assert.strictEqual(refused.status, 422, refused.text);
          assert.strictEqual(
            asObject(refused.json)["@type"],
            "AggregateNotSettled"
          );
          assert.strictEqual(
            asObject(refused.json).code,
            "AggregateNotSettled"
          );
        })
    );

    dbTest.effect(
      "an owner reference is required and read-only after create, and the class graph's refusals keep their problem codes",
      () =>
        Effect.gen(function* ownerReferences() {
          yield* change([
            PART_NAMESPACE.op,
            PART.op,
            PART_ASSET.op,
            PART_NOTE.op,
            partAccess({ kind: "records" }),
            partAccess({ fields: "*", kind: "fields" }),
          ]);

          const fixture = yield* AcmeFixture;
          const { admin } = yield* apiCallers;

          const created = yield* savedOf(
            yield* create(admin.token, PARTS, {
              asset: { id: fixture.records.S },
              note: "plain",
            })
          );

          const moved = yield* patch(
            admin.token,
            PARTS,
            created.id,
            created.version,
            { asset: { id: fixture.records.M } }
          );

          assert.strictEqual(moved.status, 422, moved.text);
          assert.strictEqual(yield* codeOf(moved), "ValidationFailed");
          assert.deepStrictEqual(fieldErrorsOf(moved.json), [
            "asset:ReadOnlyField",
          ]);

          const orphan = yield* create(admin.token, PARTS, { note: "orphan" });

          assert.strictEqual(orphan.status, 422, orphan.text);
          assert.deepStrictEqual(fieldErrorsOf(orphan.json), [
            "asset:Required",
          ]);

          // Three levels are allowed; a second owner reference, a cycle and
          // a fourth level are refused.
          const [first, middle, third, fourth] = [
            partsClass("agapi_level_1"),
            partsClass("agapi_level_2"),
            partsClass("agapi_level_3"),
            partsClass("agapi_level_4"),
          ];

          const self = partsClass("agapi_cycle");

          yield* change([
            first.op,
            middle.op,
            third.op,
            ownedBy(middle, first),
            ownedBy(third, middle),
          ]);

          const refusals: readonly (readonly [readonly Operation[], string])[] =
            [
              [
                [
                  addField(PART.id, "other_asset", {
                    aggregate: true,
                    kind: "reference",
                    targetClassId: ACME.asset,
                  }).op,
                ],
                "aggregateSecondOwner",
              ],
              [[self.op, ownedBy(self, self)], "aggregateCycle"],
              [[fourth.op, ownedBy(fourth, third)], "aggregateTooDeep"],
            ];

          for (const [operations, expected] of refusals) {
            const refused = yield* postChangeSet(admin.token, operations);

            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(yield* codeOf(refused), "DefinitionInvalid");
            assert.deepStrictEqual(problemCodesOf(refused.json), [expected]);
          }
        })
    );

    dbTest.effect(
      "a system write names in its errors only fields the caller can read on the proposed record",
      () =>
        Effect.gen(function* systemWriteErrors() {
          yield* change([BAD_DOCK.op]);

          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { alice, bob } = yield* apiCallers;
          const body = { asset: { id: fixture.records.S }, note: "bad-dock" };

          // Alice reads every asset field.
          const reader = yield* create(alice.token, PARTS, body);

          assert.strictEqual(reader.status, 422, reader.text);
          assert.strictEqual(yield* codeOf(reader), "InvalidReference");
          assert.strictEqual(asObject(reader.json).field, "dockedTo");

          // Bob owns S, which costs over 2000: he never reads its docked_to.
          const blind = yield* create(bob.token, PARTS, body);

          assert.strictEqual(blind.status, 422, blind.text);
          assert.strictEqual(yield* codeOf(blind), "ValidationFailed");
          assert.deepStrictEqual(fieldErrorsOf(blind.json), []);

          // Nothing was written.
          const asset = yield* http.get(
            `${API.asset}/${fixture.records.S}`,
            alice
          );

          assert.strictEqual(asset.status, 200, asset.text);
          assert.notProperty(asObject(asset.json), "dockedTo");
        })
    );
  });
});
