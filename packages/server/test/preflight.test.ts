/**
 * Preflight and planning cases (Contracts 1.4, 2.4, 2.5): duplicate rows
 * refuse a unique index before the main transaction, overrides on fields
 * added in the same change set, classes listed child first, required
 * booleans and keyword-like text defaults on tables with rows.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { duplicatePredicate } from "../src/schema/plan.ts";
import {
  ACME,
  addField,
  addIndex,
  addOverride,
  change,
  createClass,
  currentRevision,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ASSET = '"acme"."asset"';
const LAPTOP = '"acme"."laptop"';

const indexExists = (indexId: string) =>
  values(
    `SELECT count(*)::text AS value FROM pg_class WHERE relname = 'std_ix_' || replace($1, '-', '')`,
    [indexId]
  ).pipe(Effect.map(([value]) => value === "1"));

describe("preflight", () => {
  it("counts duplicates with the index's own key expressions", () => {
    assert.strictEqual(
      duplicatePredicate(ASSET, []),
      `() IN (SELECT  FROM ${ASSET} GROUP BY  HAVING count(*) > 1)`
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "duplicate rows refuse a unique index before the main transaction",
      () =>
        Effect.gen(function* duplicates() {
          yield* loadCoreAndAcme;

          const duplicated = yield* insertRecords([ASSET], ACME.asset, 2, {
            name: "'asset ' || g",
            status: "CASE g WHEN 1 THEN 'Lost' ELSE 'lost' END",
          });

          yield* insertRecords([ASSET], ACME.asset, 3, {
            name: "'other ' || g",
            status: "CASE g WHEN 1 THEN 'spare' ELSE NULL END",
          });

          const revision = yield* currentRevision;
          const unique = addIndex(ACME.asset, [ACME.status], true);
          const refused = yield* Effect.flip(change([unique.op]));

          assert.strictEqual(refused._tag, "ExistingDataViolates");

          if (refused._tag === "ExistingDataViolates") {
            assert.strictEqual(refused.count, 2);
            assert.strictEqual(refused.definitionId, unique.id);
            assert.deepStrictEqual(refused.sampleIds, duplicated.toSorted());
          }

          assert.strictEqual(yield* currentRevision, revision);
          assert.isFalse(yield* indexExists(unique.id));
        })
    );

    dbTest.effect(
      "an override on a field added in the same change set is checked against its default",
      () =>
        Effect.gen(function* newFieldOverride() {
          yield* loadCoreAndAcme;

          const laptops = yield* insertRecords(
            [ASSET, LAPTOP],
            ACME.laptop,
            4,
            {
              name: "'laptop ' || g",
              purchased_on: "'2026-01-01'::date",
            }
          );

          const grade = addField(ACME.asset, "grade", { kind: "text" });

          const refused = yield* Effect.flip(
            change([
              grade.op,
              addOverride(ACME.laptop, grade.id, { required: true }).op,
            ])
          );

          assert.strictEqual(refused._tag, "ExistingDataViolates");

          if (refused._tag === "ExistingDataViolates") {
            assert.strictEqual(refused.count, 4);
            assert.deepStrictEqual(refused.sampleIds, laptops.toSorted());
          }

          const defaulted = addField(
            ACME.asset,
            "tier",
            { kind: "text" },
            { default: "basic" }
          );

          const required = addOverride(ACME.laptop, defaulted.id, {
            required: true,
          });

          const accepted = yield* change([defaulted.op, required.op]);

          assert.strictEqual(accepted.state, "completed");
          assert.deepStrictEqual(
            yield* values(
              `SELECT enforcement AS value FROM core."field_override" WHERE id = $1::uuid`,
              [required.id]
            ),
            ["enforced"]
          );
        })
    );

    dbTest.effect(
      "a child listed before its parent, and a required boolean on a table with rows, apply",
      () =>
        Effect.gen(function* orderAndBooleans() {
          yield* loadCoreAndAcme;
          yield* insertRecords([ASSET], ACME.asset, 2, {
            name: "'asset ' || g",
          });

          const parent = createClass("dock_parent", {
            namespaceId: ACME.namespace,
          });

          const child = createClass("dock_child", {
            namespaceId: ACME.namespace,
            parentId: parent.id,
          });

          const ordered = yield* change([child.op, parent.op]);

          assert.strictEqual(ordered.state, "completed");

          const flag = addField(
            ACME.asset,
            "audited",
            { kind: "boolean" },
            { required: true }
          );

          const keyword = addField(
            ACME.asset,
            "motto",
            { kind: "text" },
            { default: "SET NOT NULL" }
          );

          const added = yield* change([flag.op, keyword.op]);

          assert.strictEqual(added.state, "completed");
          assert.deepStrictEqual(
            yield* values(
              `SELECT DISTINCT audited::text || ' ' || motto AS value FROM ${ASSET}`
            ),
            ["false SET NOT NULL"]
          );
        })
    );
  });
});
