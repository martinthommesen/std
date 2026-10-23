/**
 * Preflight and planning cases (Contracts 1.4, 2.4, 2.5): duplicate rows
 * refuse a unique index before the main transaction, overrides on fields
 * added in the same change set, classes listed child first, required
 * booleans and keyword-like text defaults on tables with rows.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { Effect, Layer } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
import { duplicatePredicate } from "../src/schema/plan.ts";
import {
  addField,
  addIndex,
  addOverride,
  change,
  createClass,
  currentRevision,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  SITE_NAMESPACE_ID,
  values,
} from "./schema-support.ts";
import type { BuiltOperation } from "./schema-support.ts";

const ASSET = '"acme"."asset"';
const LAPTOP = '"acme"."laptop"';

const indexExists = (indexId: string) =>
  values(
    `SELECT count(*)::text AS value FROM pg_class WHERE relname = 'std_ix_' || replace($1, '-', '')`,
    [indexId]
  ).pipe(Effect.map(([value]) => value === "1"));

/**
 * Applies a change set expected to be refused for existing data.
 * @param operations - The change set.
 * @returns The violation count, or -1 for any other outcome.
 */
const refusedCount = (operations: readonly Operation[]) =>
  Effect.flip(change(operations)).pipe(
    Effect.map((refused) =>
      refused._tag === "ExistingDataViolates" ? refused.count : -1
    )
  );

/**
 * A unique index over a field added in the same change set.
 * @param classId - The class.
 * @param field - The new field.
 * @param leading - Existing fields indexed before it.
 * @returns The two operations and the index ID.
 */
const withUniqueIndex = (
  classId: string,
  field: BuiltOperation,
  leading: readonly string[] = []
) => {
  const index = addIndex(classId, [...leading, field.id], true);

  return { id: index.id, operations: [field.op, index.op] };
};

describe("preflight", () => {
  it("counts duplicates with the index's own key expressions", () => {
    assert.strictEqual(
      duplicatePredicate(ASSET, ['"status"', "'x'::text"]),
      `("status", 'x'::text) IN (SELECT "status", 'x'::text FROM ${ASSET} GROUP BY "status", 'x'::text HAVING count(*) > 1)`
    );
  });

  layer(
    Layer.effectDiscard(loadCoreAndAcme).pipe(
      Layer.provideMerge(schemaTestLayer())
    ),
    { excludeTestServices: true }
  )((dbTest) => {
    dbTest.effect(
      "duplicate rows refuse a unique index before the main transaction",
      () =>
        Effect.gen(function* duplicates() {
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

          // A unique index on a column added in the same change set: every
          // existing row holds its initial value. All NULL is valid; one
          // constant default on several rows is a duplicate.
          const nullable = addField(ACME.asset, "tag_number", { kind: "text" });
          const tagUnique = addIndex(ACME.asset, [nullable.id], true);
          const added = yield* change([nullable.op, tagUnique.op]);

          assert.strictEqual(added.state, "completed");
          assert.isTrue(yield* indexExists(tagUnique.id));

          const constant = addField(
            ACME.asset,
            "region",
            { kind: "text" },
            { default: "EU" }
          );

          const regionUnique = addIndex(ACME.asset, [constant.id], true);

          const sameDefault = yield* Effect.flip(
            change([constant.op, regionUnique.op])
          );

          assert.strictEqual(sameDefault._tag, "ExistingDataViolates");

          if (sameDefault._tag === "ExistingDataViolates") {
            assert.strictEqual(sameDefault.definitionId, regionUnique.id);
            assert.strictEqual(sameDefault.count, 5);
          }
        })
    );

    dbTest.effect(
      "unique indexes over new boolean and integer columns count their typed initial values",
      () =>
        Effect.gen(function* typedInitialValues() {
          // A table of its own: three rows with distinct labels.
          const tally = createClass("tally", {
            namespaceId: SITE_NAMESPACE_ID,
          });

          const label = addField(tally.id, "label", { kind: "text" });

          yield* change([tally.op, label.op]);
          yield* insertRecords(['"site"."tally"'], tally.id, 3, {
            label: "'row ' || g",
          });

          // Every existing row gets false, whether implicit or the explicit
          // default, so one boolean key repeats three times.
          assert.strictEqual(
            yield* refusedCount(
              withUniqueIndex(
                tally.id,
                addField(tally.id, "checked", { kind: "boolean" })
              ).operations
            ),
            3
          );

          for (const fallback of [false, true]) {
            const flag = addField(
              tally.id,
              `flag_${fallback}`,
              { kind: "boolean" },
              { default: fallback }
            );

            assert.strictEqual(
              yield* refusedCount(withUniqueIndex(tally.id, flag).operations),
              3
            );
          }

          // Read as a bare constant, 1 would group by the first column, the
          // distinct id, and accept three equal keys.
          const ordinal = addField(
            tally.id,
            "ordinal",
            { kind: "integer" },
            { default: 1 }
          );

          assert.strictEqual(
            yield* refusedCount(withUniqueIndex(tally.id, ordinal).operations),
            3
          );

          // Distinct labels make every (label, new boolean) key distinct.
          const mixed = withUniqueIndex(
            tally.id,
            addField(tally.id, "mixed", { kind: "boolean" }),
            [label.id]
          );

          const applied = yield* change(mixed.operations);

          assert.strictEqual(applied.state, "completed");
          assert.isTrue(yield* indexExists(mixed.id));
        })
    );

    dbTest.effect(
      "an override on a field added in the same change set is checked against its default",
      () =>
        Effect.gen(function* newFieldOverride() {
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
          yield* insertRecords([ASSET], ACME.asset, 2, {
            name: "'asset ' || g",
          });

          const parent = createClass("dock_parent", {
            namespaceId: SITE_NAMESPACE_ID,
          });

          const child = createClass("dock_child", {
            namespaceId: SITE_NAMESPACE_ID,
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
