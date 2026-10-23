/**
 * Aggregates on `/api/v2` (Contracts 4.9, 10): an owner reference shows in
 * the table metadata as `aggregate: true` on its reference type, and an
 * aggregate that does not settle answers `422` with the TMF Error shape
 * of `AggregateNotSettled`, which the v2 contract checker validates
 * against the declared errors. The race over `/api/v2` and TMF621 is the
 * follow-up `aggregate-race-http` (decision 0029).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { TmfErrorSubtypes } from "@std/api/v2/tmf-error";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  addField,
  addRecordRule,
  change,
  createClass,
  createNamespace,
} from "./schema-support.ts";
import { asArray, asObject, textOf, v2Callers } from "./v2-support.ts";

const NAMESPACE = createNamespace("agv2");
const BOX = createClass("agv2_box", { namespaceId: NAMESPACE.id });
const ITEM = createClass("agv2_item", { namespaceId: NAMESPACE.id });
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

describe("aggregate-v2", () => {
  it("declares AggregateNotSettled as a v2 error subtype", () => {
    assert.strictEqual(new AggregateNotSettled()._tag, "AggregateNotSettled");
    assert.property(TmfErrorSubtypes, "AggregateNotSettled");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an owner reference shows in the table metadata, and an aggregate that does not settle is a 422 TMF Error",
      () =>
        Effect.gen(function* v2Aggregates() {
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
          const { admin } = yield* v2Callers;

          const listed = yield* http.get("/api/v2/tableMetadata", admin);

          const item = entryWith(listed.json, "label", "agv2_item").id;
          const box = entryWith(listed.json, "label", "agv2_box").id;

          const metadata = yield* http.get(
            `/api/v2/tableMetadata/${textOf(item)}`,
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
            `/api/v2/${textOf(box)}`,
            {
              ...admin,
              body: { count: 0 },
            }
          );

          assert.strictEqual(created.status, 201, created.text);

          const refused = yield* http.request(
            "POST",
            `/api/v2/${textOf(item)}`,
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
  });
});
