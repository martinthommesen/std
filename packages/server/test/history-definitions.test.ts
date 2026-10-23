/**
 * History entries carry their definitions (Contracts 4.4, 4.5, decision
 * 0020): each entry's `fields` describes the fields of its `changes`, keyed
 * the same way, with the label, type and choice labels they had at the
 * entry's schema revision.
 *
 * An asset gets a choice field `grade` (choices `good` and `fair`) and a
 * text field `memo`. After a save, `grade` is renamed and relabeled and
 * the choice `good` relabeled; a second save changes `grade`. Then `memo`
 * is retired and purged.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { renderSql } from "@std/conditions/sql-fragment";
import type { SqlFragment, SqlParameter } from "@std/conditions/sql-fragment";
import type { ChoiceDraft } from "@std/definitions/definition";
import type { Requester } from "@std/definitions/requester";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { definitionAt } from "../src/catalog/definition-revisions.ts";
import { definitionRevisionsStatement } from "../src/records/history-definitions.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { arrayOf, objectOf, signInAll, textOf } from "./authz-support.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { definitionVersion } from "./schema-paths-support.ts";
import { ACME, addField, change, currentRevision } from "./schema-support.ts";
import type { BuiltOperation } from "./schema-support.ts";

const local = { owner: { layer: "local" }, protected: false } as const;

/** The last revision whose number has one digit. */
const MAX_SINGLE_DIGIT = 9;

/** Revision rows of other definitions, seeded before the plan is read. */
const UNRELATED_REVISIONS = 100_000;

const decodePlan = decodeRows(Schema.Struct({ "QUERY PLAN": Schema.String }));

const decodePlanValues = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Tuple([Schema.String]))
);

/**
 * A statement's plan for its values.
 *
 * @param statement - The statement.
 * @returns The plan's lines.
 */
const customPlan = (statement: SqlFragment) =>
  Effect.gen(function* explainCustom() {
    const sql = yield* SqlClient.SqlClient;
    const { text, values } = renderSql(statement);

    const rows = yield* decodePlan(
      yield* sql.unsafe(`EXPLAIN (COSTS OFF) ${text}`, values)
    );

    return rows.map((row) => row["QUERY PLAN"]);
  });

/**
 * A parameter's type, as `PREPARE` declares it.
 *
 * @param parameter - The parameter.
 * @returns Its type.
 */
const typeOf = (parameter: SqlParameter): string =>
  parameter.kind === "textArray" ? `${parameter.cast}[]` : parameter.cast;

/**
 * A parameter as a typed literal; test values are UUIDs and numbers.
 *
 * @param parameter - The parameter.
 * @returns The literal.
 */
const literalOf = (parameter: SqlParameter): string =>
  parameter.kind === "textArray"
    ? `'{${parameter.values.join(",")}}'::${typeOf(parameter)}`
    : `'${parameter.value}'::${typeOf(parameter)}`;

/**
 * A statement's generic plan, as a prepared statement runs it after five
 * executions: prepared on one connection with `force_generic_plan`, then
 * explained with `EXECUTE`. `EXECUTE` takes literals, because a utility
 * statement's placeholders get no types.
 *
 * @param statement - The statement.
 * @returns The plan's lines.
 */
const genericPlan = (statement: SqlFragment) =>
  Effect.scoped(
    Effect.gen(function* explainGeneric() {
      const sql = yield* SqlClient.SqlClient;
      const connection = yield* sql.reserve;
      const { text } = renderSql(statement);

      const run = (command: string) =>
        connection.executeValuesUnprepared(command, []);

      const types = statement.parameters.map(typeOf).join(", ");
      const literals = statement.parameters.map(literalOf).join(", ");

      yield* run("SET plan_cache_mode = force_generic_plan");
      yield* run(`PREPARE history_revisions (${types}) AS ${text}`);

      const rows = yield* decodePlanValues(
        yield* run(`EXPLAIN (COSTS OFF) EXECUTE history_revisions(${literals})`)
      );

      yield* run("DEALLOCATE history_revisions");
      yield* run("RESET plan_cache_mode");

      return rows.map(([line]) => line);
    })
  );

const PURGER: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
  userId: randomUUID(),
};

const choice = (
  fieldId: string,
  key: string,
  label: string,
  order: number
): BuiltOperation => {
  const definition: ChoiceDraft = {
    ...local,
    fieldId,
    hidden: false,
    id: randomUUID(),
    key,
    kind: "choice",
    label,
    order,
  };

  return { id: definition.id, op: { definition, op: "createChoice" } };
};

const historyOf = Effect.fn("HistoryDefinitions.historyOf")(function* historyOf(
  token: string,
  id: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(`${recordPath("acme.asset", id)}/history`, {
    token,
  });

  assert.strictEqual(response.status, 200, response.text);

  return arrayOf(response.json).map(objectOf);
});

const keysOf = (value: JsonValue | undefined): string[] =>
  Object.keys(objectOf(value)).toSorted();

/**
 * Every entry describes exactly the fields it changes.
 *
 * @param entries - The entries.
 */
const describesItsChanges = (entries: readonly JsonObject[]): void => {
  for (const entry of entries) {
    assert.deepStrictEqual(keysOf(entry.fields), keysOf(entry.changes));
  }
};

describe("history-definitions", () => {
  it("keys descriptions like changes", () => {
    assert.deepStrictEqual(keysOf({ a: 2, b: 1 }), ["a", "b"]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "each entry shows its fields' label, type and choice labels as they were at its revision",
      () =>
        Effect.gen(function* entriesAtTheirRevision() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const fixture = yield* AcmeFixture;

          const grade = addField(ACME.asset, "grade", { kind: "choice" });
          const memo = addField(ACME.asset, "memo", { kind: "text" });

          yield* change([grade.op, memo.op]);

          const good = choice(grade.id, "good", "Good", 1);

          yield* change([good.op, choice(grade.id, "fair", "Fair", 2).op]);

          // Alice creates an asset Bob owns, so both read its history.
          const created = yield* http.request("POST", listPath("acme.asset"), {
            body: {
              cost: "100.00",
              grade: "good",
              memo: "first",
              name: "H1",
              owner: fixture.bob.id,
            },
            token: tokens.alice,
          });

          assert.strictEqual(created.status, 201, created.text);

          const id = textOf(objectOf(created.json).id);

          // Rename and relabel the field, relabel a choice.
          yield* change([
            {
              id: grade.id,
              name: "quality",
              op: "rename",
              version: yield* definitionVersion(grade.id),
            },
          ]);
          yield* change([
            {
              changes: { label: "Quality" },
              id: grade.id,
              op: "update",
              version: yield* definitionVersion(grade.id),
            },
            {
              changes: { label: "Great" },
              id: good.id,
              op: "update",
              version: yield* definitionVersion(good.id),
            },
          ]);

          const updated = yield* http.request(
            "PATCH",
            recordPath("acme.asset", id),
            {
              body: { cost: "200.00", quality: "fair" },
              headers: { "if-match": '"1"' },
              token: tokens.alice,
            }
          );

          assert.strictEqual(updated.status, 200, updated.text);

          const alice = yield* historyOf(tokens.alice, id);

          describesItsChanges(alice);

          const [first, second] = alice;
          const before = objectOf(first?.fields);
          const after = objectOf(second?.fields);

          // Keyed by the current name; described as it was then.
          assert.deepStrictEqual(before.quality, {
            choices: [
              { key: "good", label: "Good" },
              { key: "fair", label: "Fair" },
            ],
            label: "grade",
            type: { kind: "choice" },
          });
          assert.deepStrictEqual(after.quality, {
            choices: [
              { key: "good", label: "Great" },
              { key: "fair", label: "Fair" },
            ],
            label: "Quality",
            type: { kind: "choice" },
          });
          assert.deepStrictEqual(before.cost, {
            choices: null,
            label: objectOf(before.cost).label ?? null,
            type: { kind: "decimal", precision: 12, scale: 2 },
          });
          assert.deepStrictEqual(before.owner, {
            choices: null,
            label: objectOf(before.owner).label ?? null,
            type: { kind: "reference", target: "core.user" },
          });

          // Bob cannot read `cost`: neither its change nor its description.
          const bob = yield* historyOf(tokens.bob, id);

          describesItsChanges(bob);

          for (const entry of bob) {
            assert.notProperty(objectOf(entry.fields), "cost");
            assert.notProperty(objectOf(entry.changes), "cost");
          }

          assert.deepStrictEqual(
            objectOf(bob[1]?.fields).quality,
            after.quality
          );
          assert.notInclude(JSON.stringify(bob), '"cost"');

          // A purged field's changes (admins only) keep its definitions.
          yield* change([
            {
              id: memo.id,
              op: "retire",
              version: yield* definitionVersion(memo.id),
            },
          ]);
          yield* applyChangeSet({
            operations: [
              {
                confirm: {
                  id: memo.id,
                  version: yield* definitionVersion(memo.id),
                },
                id: memo.id,
                op: "purge",
                version: yield* definitionVersion(memo.id),
              },
            ],
            requester: PURGER,
          });

          const admin = yield* historyOf(tokens.admin, id);

          describesItsChanges(admin);
          assert.deepStrictEqual(objectOf(admin[0]?.fields).memo, {
            choices: null,
            label: "memo",
            type: { kind: "text" },
          });
          assert.notProperty(
            objectOf((yield* historyOf(tokens.alice, id))[0]?.fields),
            "memo"
          );
        })
    );
  });

  // Revisions are numbers: 10 comes after 9, though "10" sorts before "9".
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an entry at revision 10 or later shows its own revision's definitions, not revision 9's",
      () =>
        Effect.gen(function* acrossRevisionTen() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const fixture = yield* AcmeFixture;

          const tier = addField(ACME.asset, "tier", { kind: "choice" });

          yield* change([tier.op]);

          const gold = choice(tier.id, "gold", "Gold", 1);

          yield* change([gold.op, choice(tier.id, "iron", "Iron", 2).op]);
          assert.isBelow(yield* currentRevision, MAX_SINGLE_DIGIT);

          const created = yield* http.request("POST", listPath("acme.asset"), {
            body: { name: "T1", owner: fixture.bob.id, tier: "gold" },
            token: tokens.alice,
          });

          assert.strictEqual(created.status, 201, created.text);

          const id = textOf(objectOf(created.json).id);

          // Relabel the field and a choice once per revision, up to 10.
          while ((yield* currentRevision) <= MAX_SINGLE_DIGIT) {
            const next = (yield* currentRevision) + 1;

            yield* change([
              {
                changes: { label: `Tier ${next}` },
                id: tier.id,
                op: "update",
                version: yield* definitionVersion(tier.id),
              },
              {
                changes: { label: `Gold ${next}` },
                id: gold.id,
                op: "update",
                version: yield* definitionVersion(gold.id),
              },
            ]);
          }

          const revision = yield* currentRevision;

          assert.strictEqual(revision, MAX_SINGLE_DIGIT + 1);

          const updated = yield* http.request(
            "PATCH",
            recordPath("acme.asset", id),
            {
              body: { tier: "iron" },
              headers: { "if-match": '"1"' },
              token: tokens.alice,
            }
          );

          assert.strictEqual(updated.status, 200, updated.text);

          const [first, second] = yield* historyOf(tokens.alice, id);

          assert.deepStrictEqual(objectOf(first?.fields).tier, {
            choices: [
              { key: "gold", label: "Gold" },
              { key: "iron", label: "Iron" },
            ],
            label: "tier",
            type: { kind: "choice" },
          });
          assert.strictEqual(second?.schemaRevision, revision);
          assert.deepStrictEqual(objectOf(second?.fields).tier, {
            choices: [
              { key: "gold", label: `Gold ${revision}` },
              { key: "iron", label: "Iron" },
            ],
            label: `Tier ${revision}`,
            type: { kind: "choice" },
          });

          // The catalog's single-definition lookup orders the same way.
          assert.strictEqual(
            (yield* definitionAt(tier.id, revision))?.revision,
            revision
          );
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the lookup uses an index per branch, not a scan of every revision",
      () =>
        Effect.gen(function* indexedLookup() {
          const sql = yield* SqlClient.SqlClient;

          const shade = addField(ACME.asset, "shade", { kind: "choice" });

          yield* change([shade.op]);
          yield* change([choice(shade.id, "dark", "Dark", 1).op]);

          // Unrelated revisions of fields, overrides and choices, as table
          // owner.
          yield* sql.unsafe(
            `INSERT INTO core.definition_revision
               (definition_id, revision, kind, effective)
             SELECT uuidv7(), 1 + g % 5,
               (ARRAY['field', 'override', 'choice'])[1 + g % 3],
               jsonb_build_object('fieldId', gen_random_uuid()::text)
             FROM generate_series(1, $1::int4) AS g`,
            [String(UNRELATED_REVISIONS)]
          );
          yield* sql`ANALYZE core.definition_revision`;

          const statement = definitionRevisionsStatement(
            [shade.id, ACME.asset],
            [shade.id],
            yield* currentRevision
          );

          // The plan for these values, and the generic plan a prepared
          // statement may switch to after five runs.
          for (const plan of [
            yield* customPlan(statement),
            yield* genericPlan(statement),
          ]) {
            assert.isTrue(
              plan.some((line) => line.includes("definition_revision_pkey")),
              plan.join("\n")
            );
            assert.isTrue(
              plan.some((line) => line.includes("definition_revision_field")),
              plan.join("\n")
            );
            assert.isFalse(
              plan.some((line) => line.includes("Seq Scan")),
              plan.join("\n")
            );
          }
        })
    );
  });
});
