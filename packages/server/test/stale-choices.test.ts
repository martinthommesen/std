/**
 * Stale requests and choices (Contracts 6.4): a write built before a
 * choice field's choices changed (a choice added, hidden or deleted, or an
 * override's choice subset changed on the record's class) gets
 * `SchemaChanged` (409) with kind `choicesChanged` for that field, and
 * writes nothing; a choice label change is not relevant, so the same write
 * succeeds.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { ChoiceDraft, OverrideDraft } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { arrayOf, objectOf, signInAll, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { readsTestLayer, recordPath } from "./reads-support.ts";
import {
  ACME,
  addField,
  addOverride,
  change,
  values,
} from "./schema-support.ts";

const local = { owner: { layer: "local" }, protected: false } as const;

const choiceDraft = (
  fieldId: string,
  key: string,
  order: number
): ChoiceDraft => ({
  ...local,
  fieldId,
  hidden: false,
  id: randomUUID(),
  key,
  kind: "choice",
  label: key,
  order,
});

const createChoice = (definition: ChoiceDraft): Operation => ({
  definition,
  op: "createChoice",
});

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });

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

  const [version] = yield* values(
    "SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid",
    [target.id]
  );

  return yield* http.request("PATCH", recordPath("acme.laptop", target.id), {
    body: { tier: key },
    headers: {
      "if-match": `"${version ?? "0"}"`,
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
  assert.strictEqual(objectOf(response.json)._tag, "SchemaChanged", what);
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
          const { fixture, tokens } = yield* signInAll;
          const target: Target = { id: fixture.records.K, token: tokens.admin };
          const tier = addField(ACME.asset, "tier", { kind: "choice" });

          yield* change([tier.op]);

          const gold = choiceDraft(tier.id, "gold", 1);
          const silver = choiceDraft(tier.id, "silver", 2);
          const bronze = choiceDraft(tier.id, "bronze", 3);

          const subset = addOverride(ACME.laptop, tier.id, {
            choices: ["gold", "silver"],
          });

          yield* change([createChoice(gold), createChoice(silver), subset.op]);

          yield* staleAfter(target, "a choice added", [createChoice(bronze)]);
          yield* staleAfter(target, "a choice hidden", [
            {
              changes: { hidden: true },
              id: silver.id,
              op: "update",
              version: yield* versionOf(silver.id),
            },
          ]);
          yield* staleAfter(target, "a choice deleted", [
            {
              id: bronze.id,
              op: "delete",
              version: yield* versionOf(bronze.id),
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
              version: yield* versionOf(gold.id),
            },
          ]);

          const saved = yield* saveTier(target, stated, "gold");

          assert.strictEqual(saved.status, 200, saved.text);
        })
    );
  });
});
