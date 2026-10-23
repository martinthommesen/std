/**
 * Choice fields with labels and choice-subset overrides on child classes
 * (plan Step 2; Contracts 2.5, 6.5, 8.2): the record service checks a key
 * against the effective subset of the record's concrete class through the
 * child and the parent endpoint, keeps an unchanged hidden key, reads
 * return the key and metadata the labels. A tightening subset on a class
 * with violating records is refused with a count, and `doctor` reports a
 * violation planted behind the service's back.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { TableMetadata } from "@std/api/table-metadata";
import type { ChoiceDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { arrayOf, objectOf, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import {
  codeOf,
  collectionOf,
  listPath,
  readsTestLayer,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { postChangeSet } from "./schema-paths-support.ts";
import {
  ACME,
  addField,
  addOverride,
  change,
  values,
} from "./schema-support.ts";

const local = { owner: { layer: "local" }, protected: false } as const;

const choice = (
  fieldId: string,
  key: string,
  order: number,
  hidden = false
): Operation => {
  const definition: ChoiceDraft = {
    ...local,
    fieldId,
    hidden,
    id: randomUUID(),
    key,
    kind: "choice",
    label: `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`,
    order,
  };

  return { definition, op: "createChoice" };
};

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadata);

// The error code and the invalid-value reason a refusal gives `tier`.
const reasonOf = (response: TestResponse): string => {
  const body = objectOf(response.json);

  const error = arrayOf(body.fieldErrors).find(
    (entry) => objectOf(entry).field === "tier"
  );

  return `${textOf(body.code)}/${textOf(objectOf(error).reason)}`;
};

const versionOf = (id: string) =>
  values("SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid", [
    id,
  ]).pipe(Effect.map(([version]) => version ?? "0"));

/** One refused write: what it sends and the refusal it must get. */
interface Refusal {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue;
  readonly expected: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const refusedWith = Effect.fn("Choices.refusedWith")(function* refusedWith(
  token: string,
  refusal: Refusal
) {
  const http = yield* TestHttpClient;
  const before = yield* committedState;

  const response = yield* http.request(refusal.method, refusal.path, {
    body: refusal.body,
    headers: refusal.headers ?? {},
    token,
  });

  assert.strictEqual(response.status, 422, response.text);
  assert.strictEqual(reasonOf(response), refusal.expected);
  assert.deepStrictEqual(yield* committedState, before);
});

const metaOf = Effect.fn("Choices.metaOf")(function* metaOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(
    `/api/v1/tableMetadata/${collectionOf(table)}`,
    { token }
  );

  return yield* decodeMetadata(response.json).pipe(Effect.orDie);
});

const choicesOf = (table: typeof TableMetadata.Type) =>
  table.fields.find((field) => field.name === "tier")?.choices;

const setup = Effect.gen(function* setupChoices() {
  const tier = addField(ACME.asset, "tier", { kind: "choice" });

  yield* change([tier.op]);

  const subset = addOverride(ACME.laptop, tier.id, {
    choices: ["gold", "silver", "legacy"],
  });

  yield* change([
    choice(tier.id, "gold", 1),
    choice(tier.id, "silver", 2),
    choice(tier.id, "bronze", 3),
    choice(tier.id, "legacy", 4, true),
    subset.op,
  ]);

  return { override: subset.id, tier: tier.id };
});

describe("choice fields", () => {
  it("reads the reason a refusal gives the field", () => {
    const text =
      '{"code":"ValidationFailed","fieldErrors":[{"_tag":"InvalidValue","field":"tier","reason":"unknownChoice"}]}';

    const parsed = parseJson(text);

    assert.strictEqual(
      reasonOf({
        headers: new Headers(),
        json: parsed.ok ? parsed.value : undefined,
        status: 422,
        text,
      }),
      "ValidationFailed/unknownChoice"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a child's choice subset is enforced through the child and the parent endpoint",
      () =>
        Effect.gen(function* subsets() {
          const ids = yield* setup;
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { K } = fixture.records;
          const token = yield* http.signIn("ada", "ada-password");

          // Creates: a laptop only takes keys of its subset; a plain asset
          // takes every active key of the field.
          yield* refusedWith(token, {
            body: { name: "Bronze laptop", serial: "B-1", tier: "bronze" },
            expected: "ValidationFailed/unknownChoice",
            method: "POST",
            path: listPath("acme.laptop"),
          });
          yield* refusedWith(token, {
            body: { name: "Legacy laptop", serial: "B-2", tier: "legacy" },
            expected: "ValidationFailed/retiredChoice",
            method: "POST",
            path: listPath("acme.laptop"),
          });

          const asset = yield* http.request("POST", listPath("acme.asset"), {
            body: { name: "Bronze asset", tier: "bronze" },
            token,
          });

          assert.strictEqual(asset.status, 201, asset.text);

          const laptop = yield* http.request("POST", listPath("acme.laptop"), {
            body: {
              name: "Gold laptop",
              purchasedOn: "2026-01-02",
              serial: "G-1",
              tier: "gold",
            },
            token,
          });

          assert.strictEqual(laptop.status, 201, laptop.text);
          assert.strictEqual(objectOf(laptop.json).tier, "gold");

          // Updates of laptop K through both endpoints.
          for (const table of ["acme.laptop", "acme.asset"]) {
            const ifMatch = { "if-match": `"${yield* versionOf(K)}"` };

            yield* refusedWith(token, {
              body: { tier: "bronze" },
              expected: "ValidationFailed/unknownChoice",
              headers: ifMatch,
              method: "PATCH",
              path: recordPath(table, K),
            });
            yield* refusedWith(token, {
              body: { tier: "legacy" },
              expected: "ValidationFailed/retiredChoice",
              headers: ifMatch,
              method: "PATCH",
              path: recordPath(table, K),
            });
          }

          // A hidden key already stored is kept while unchanged.
          yield* values(
            "UPDATE acme.asset SET tier = 'legacy' WHERE id = $1::uuid RETURNING id::text AS value",
            [K]
          );

          const kept = yield* http.request(
            "PATCH",
            recordPath("acme.asset", K),
            {
              body: { name: "Laptop K renamed", tier: "legacy" },
              headers: { "if-match": `"${yield* versionOf(K)}"` },
              token,
            }
          );

          assert.strictEqual(kept.status, 200, kept.text);

          const read = yield* resourceOf(
            yield* http.get(recordPath("acme.laptop", K), { token })
          );

          assert.strictEqual(read.tier, "legacy");

          // Metadata: the parent's whole list, the child's subset, labels.
          assert.deepStrictEqual(
            choicesOf(yield* metaOf(token, "acme.asset")),
            [
              { key: "gold", label: "Gold", order: 1, retired: false },
              { key: "silver", label: "Silver", order: 2, retired: false },
              { key: "bronze", label: "Bronze", order: 3, retired: false },
              { key: "legacy", label: "Legacy", order: 4, retired: true },
            ]
          );
          assert.deepStrictEqual(
            choicesOf(yield* metaOf(token, "acme.laptop")),
            [
              { key: "gold", label: "Gold", order: 1, retired: false },
              { key: "silver", label: "Silver", order: 2, retired: false },
              { key: "legacy", label: "Legacy", order: 4, retired: true },
            ]
          );

          // Tightening the subset while a laptop holds `legacy` is refused
          // with the count, and nothing changes.
          const snapshot = yield* (yield* Catalog).refresh;
          const override = snapshot.getKind("override", ids.override);

          if (override === undefined) {
            throw new Error("no override");
          }

          const tighten: Operation = {
            definition: {
              choices: ["gold", "silver"],
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
            },
            op: "setOverride",
            version: override.version,
          };

          const before = yield* committedState;
          const tightened = yield* postChangeSet(token, [tighten]);

          assert.strictEqual(tightened.status, 409, tightened.text);

          const refusal = objectOf(tightened.json);

          assert.strictEqual(refusal.code, "ExistingDataViolates");
          assert.strictEqual(refusal.count, 1);
          assert.deepStrictEqual(refusal.sampleIds, [K]);
          assert.deepStrictEqual(yield* committedState, before);

          // A violation planted as table owner is reported by doctor.
          assert.strictEqual((yield* runDoctor()).exitCode, 0);

          yield* values(
            "UPDATE acme.asset SET tier = 'bronze' WHERE id = $1::uuid RETURNING id::text AS value",
            [K]
          );

          const report = yield* runDoctor();

          const violation = report.findings.find(
            (finding) => finding.code === "overrideViolated"
          );

          assert.strictEqual(report.exitCode, 1);
          assert.strictEqual(violation?.subject, ids.override);
          assert.strictEqual(violation?.check, 8);
        })
    );

    dbTest.effect(
      "filter literals name a choice of the field; a hidden one is allowed",
      () =>
        Effect.gen(function* filters() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");

          const filtered = (table: string, filter: string) =>
            http.get(listPath(table, { condition: filter }), { token });

          const unknown = yield* filtered("acme.asset", 'tier = "nosuch"');

          assert.strictEqual(unknown.status, 400, unknown.text);
          assert.strictEqual(yield* codeOf(unknown), "InvalidFilter");
          assert.include(unknown.text, "This field has no such choice.");

          // A hidden key, and a key outside the child's subset through the
          // child's endpoint: the field's whole list is checked.
          for (const [table, filter] of [
            ["acme.asset", 'tier = "legacy"'],
            ["acme.laptop", 'tier in ("bronze", "gold")'],
          ] as const) {
            const response = yield* filtered(table, filter);

            assert.strictEqual(response.status, 200, response.text);
          }

          // A stored condition naming no choice is refused when stored.
          const snapshot = yield* (yield* Catalog).refresh;

          const tier = snapshot
            .fields(ACME.asset)
            .find((field) => field.name === "tier");

          const before = yield* committedState;

          const rule = yield* http.request(
            "POST",
            listPath("core.access_rule"),
            {
              body: {
                actions: ["read"],
                condition: {
                  left: { path: [tier?.id ?? ""] },
                  op: "eq",
                  right: { value: "nosuch" },
                },
                effect: "deny",
                name: null,
                roleIds: [BUILT_IN_ROLE_IDS.authenticated],
                tableId: ACME.asset,
                target: "records",
              },
              token,
            }
          );

          assert.strictEqual(rule.status, 422, rule.text);
          assert.strictEqual(yield* codeOf(rule), "DefinitionInvalid");
          assert.include(rule.text, "invalidCondition");
          assert.deepStrictEqual(yield* committedState, before);
        })
    );
  });
});
