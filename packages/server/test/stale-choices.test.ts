/**
 * Stale requests and choices (Contracts 6.4): a write built before a
 * choice field's choices changed (a choice added, hidden or deleted, or an
 * override's choice subset changed on the record's class) gets
 * `SchemaChanged` (409) with kind `choicesChanged` for that field, and
 * writes nothing; a choice label change is not relevant, so the same write
 * succeeds.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { OverrideDraft } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { arrayOf, objectOf, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { definitionVersion } from "./schema-paths-support.ts";
import {
  ACME,
  addField,
  addChoice,
  addOverride,
  change,
} from "./schema-support.ts";
import { versionOf } from "./writes-support.ts";

/** Where the test writes: laptop K as the administrator. */
interface Target {
  readonly token: string;
  readonly id: DefinitionId;
}

const revisionNow = Effect.fn("StaleChoices.revisionNow")(function* revisionNow(
  target: Target
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(recordPath("acme.laptop", target.id), {
    token: target.token,
  });

  return response.headers.get("std-schema-revision") ?? "";
});

const saveTier = Effect.fn("StaleChoices.saveTier")(function* saveTier(
  target: Target,
  stated: string,
  key: string
) {
  const http = yield* TestHttpClient;

  const version = yield* versionOf(target.id);

  return yield* http.request("PATCH", recordPath("acme.laptop", target.id), {
    body: { tier: key },
    headers: {
      "if-match": `"${version ?? 0}"`,
      "std-schema-revision": stated,
    },
    token: target.token,
  });
});

// The changes of a `SchemaChanged` body, as `field/kind`.
const changesOf = (json: Parameters<typeof objectOf>[0]): string[] =>
  arrayOf(objectOf(json).changes).map((entry) => {
    const changed = objectOf(entry);

    return `${textOf(changed.field)}/${textOf(changed.kind)}`;
  });

const staleAfter = Effect.fn("StaleChoices.staleAfter")(function* staleAfter(
  target: Target,
  what: string,
  operations: readonly Operation[]
) {
  const stated = yield* revisionNow(target);

  yield* change(operations);

  const before = yield* committedState;
  const response = yield* saveTier(target, stated, "gold");

  assert.strictEqual(response.status, 409, `${what}: ${response.text}`);
  assert.strictEqual(objectOf(response.json).code, "SchemaChanged", what);
  assert.deepStrictEqual(
    changesOf(response.json),
    ["tier/choicesChanged"],
    what
  );
  assert.deepStrictEqual(yield* committedState, before, what);
});

describe("stale requests and choices", () => {
  it("lists changes as field and kind", () => {
    assert.deepStrictEqual(
      changesOf({ changes: [{ field: "tier", kind: "choicesChanged" }] }),
      ["tier/choicesChanged"]
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "choicesChanged after a choice or a subset changes; a label change is not relevant",
      () =>
        Effect.gen(function* staleChoices() {
          const fixture = yield* AcmeFixture;

          const token = yield* (yield* TestHttpClient).signIn(
            fixture.admin.login,
            "ada-password"
          );

          const target: Target = { id: fixture.records.K, token };
          const tier = addField(ACME.asset, "tier", { kind: "choice" });

          yield* change([tier.op]);

          const gold = addChoice(tier.id, "gold", { order: 1 });
          const silver = addChoice(tier.id, "silver", { order: 2 });
          const bronze = addChoice(tier.id, "bronze", { order: 3 });

          const subset = addOverride(ACME.laptop, tier.id, {
            choices: ["gold", "silver"],
          });

          yield* change([gold.op, silver.op, subset.op]);

          yield* staleAfter(target, "a choice added", [bronze.op]);
          yield* staleAfter(target, "a choice hidden", [
            {
              changes: { hidden: true },
              id: silver.id,
              op: "update",
              version: yield* definitionVersion(silver.id),
            },
          ]);
          yield* staleAfter(target, "a choice deleted", [
            {
              id: bronze.id,
              op: "delete",
              version: yield* definitionVersion(bronze.id),
            },
          ]);

          const override = (yield* (yield* Catalog).refresh).getKind(
            "override",
            subset.id
          );

          if (override === undefined) {
            throw new Error("no override");
          }

          const draft: OverrideDraft = {
            choices: ["gold"],
            classId: override.classId,
            default: override.default,
            fieldId: override.fieldId,
            helpText: override.helpText,
            id: override.id,
            kind: "override",
            label: override.label,
            max: override.max,
            maxLength: override.maxLength,
            min: override.min,
            numberPrefix: override.numberPrefix,
            owner: override.owner,
            protected: override.protected,
            readOnly: override.readOnly,
            required: override.required,
          };

          yield* staleAfter(target, "the class's subset changed", [
            {
              definition: draft,
              op: "setOverride",
              version: override.version,
            },
          ]);

          // A label change is not relevant: the same save succeeds.
          const stated = yield* revisionNow(target);

          yield* change([
            {
              changes: { label: "Gold!" },
              id: gold.id,
              op: "update",
              version: yield* definitionVersion(gold.id),
            },
          ]);

          const saved = yield* saveTier(target, stated, "gold");

          assert.strictEqual(saved.status, 200, saved.text);
        })
    );

    dbTest.effect(
      "a child's subset change is relevant to creates of the child and to updates through the parent, not to creates of the parent",
      () =>
        Effect.gen(function* childSubsetScope() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;

          const token = yield* (yield* TestHttpClient).signIn(
            fixture.admin.login,
            "ada-password"
          );

          const target: Target = { id: fixture.records.K, token };
          const grade = addField(ACME.asset, "grade", { kind: "choice" });

          yield* change([grade.op]);
          yield* change([
            addChoice(grade.id, "good", { order: 1 }).op,
            addChoice(grade.id, "fair", { order: 2 }).op,
          ]);

          const stated = yield* revisionNow(target);

          // The monitor class restricts `grade` after the request's revision.
          yield* change([
            addOverride(ACME.monitor, grade.id, { choices: ["good"] }).op,
          ]);

          const createOn = (table: string) =>
            http.request("POST", listPath(table), {
              body: { grade: "good", name: `stale ${table}` },
              headers: { "std-schema-revision": stated },
              token,
            });

          // A create makes a record of exactly its endpoint's class: the
          // monitor's subset does not apply to an asset.
          const parent = yield* createOn("acme.asset");

          assert.strictEqual(parent.status, 201, parent.text);

          // A monitor create is stale, and so is an update through the
          // parent endpoint, which may reach a monitor record.
          const before = yield* committedState;
          const child = yield* createOn("acme.monitor");

          assert.strictEqual(child.status, 409, child.text);
          assert.deepStrictEqual(changesOf(child.json), [
            "grade/choicesChanged",
          ]);

          const version = yield* versionOf(fixture.records.M);

          const throughParent = yield* http.request(
            "PATCH",
            recordPath("acme.asset", fixture.records.M),
            {
              body: { grade: "good" },
              headers: {
                "if-match": `"${version ?? 0}"`,
                "std-schema-revision": stated,
              },
              token,
            }
          );

          assert.strictEqual(throughParent.status, 409, throughParent.text);
          assert.deepStrictEqual(yield* committedState, before);
        })
    );
  });
});
