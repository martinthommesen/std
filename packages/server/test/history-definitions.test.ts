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
import type { ChoiceDraft } from "@std/definitions/definition";
import type { Requester } from "@std/definitions/requester";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { arrayOf, objectOf, signInAll, textOf } from "./authz-support.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { ACME, addField, change } from "./schema-support.ts";
import type { BuiltOperation } from "./schema-support.ts";

const local = { owner: { layer: "local" }, protected: false } as const;

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

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });

const historyOf = Effect.fn("HistoryDefinitions.historyOf")(function* historyOf(
  token: string,
  id: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(`${recordPath("acme.asset", id)}/history`, {
    token,
  });

  assert.strictEqual(response.status, 200, response.text);

  return arrayOf(objectOf(response.json).entries).map(objectOf);
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

          const id = textOf(objectOf(objectOf(created.json).record).id);

          // Rename and relabel the field, relabel a choice.
          yield* change([
            {
              id: grade.id,
              name: "quality",
              op: "rename",
              version: yield* versionOf(grade.id),
            },
          ]);
          yield* change([
            {
              changes: { label: "Quality" },
              id: grade.id,
              op: "update",
              version: yield* versionOf(grade.id),
            },
            {
              changes: { label: "Great" },
              id: good.id,
              op: "update",
              version: yield* versionOf(good.id),
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
            { id: memo.id, op: "retire", version: yield* versionOf(memo.id) },
          ]);
          yield* applyChangeSet({
            operations: [
              {
                confirm: { id: memo.id, version: yield* versionOf(memo.id) },
                id: memo.id,
                op: "purge",
                version: yield* versionOf(memo.id),
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
});
