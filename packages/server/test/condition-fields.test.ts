/**
 * Condition fields on records (Contracts 1.7, 5.2, 6.5; decision 0005,
 * "Condition fields"), through the HTTP API on the acme example.
 *
 * A `matches` field on `acme.asset` holds filter-profile conditions on
 * `acme.asset`. A written, non-null value is checked as being stored,
 * against that class and profile in the caller's view: unknown and
 * retired fields, operators that do not fit the type or the profile, and
 * literals that do not convert are `ValidationFailed` with an
 * `invalidCondition` on the field. A field the caller can never read is
 * unknown, byte for byte like an ID that names nothing. Conditions store
 * field IDs, so a rename changes nothing; a retire leaves stored values
 * alone until the field is written again. The field's `condition_on` edge
 * keeps its class from being retired, through the change-set endpoint.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { signInAll } from "./authz-support.ts";
import {
  codeOf,
  readsTestLayer,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { rootVersion } from "./records-support.ts";
import { postChangeSet } from "./schema-paths-support.ts";
import {
  definitionVersion,
  addField,
  createClass,
  ensureSite,
  SITE_NAMESPACE_ID,
  addAccessRule,
} from "./schema-support.ts";
import { ASSET, create, patch } from "./writes-support.ts";

/** The condition field's name. */
const MATCHES = "matches";

const ValidationFailedBody = Schema.Struct({
  code: Schema.Literal("ValidationFailed"),
  fieldErrors: Schema.Array(
    Schema.Struct({
      _tag: Schema.String,
      field: Schema.String,
      hint: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    })
  ),
});

const decodeValidation = Schema.decodeUnknownEffect(ValidationFailedBody);

/**
 * Posts a change set that must apply.
 * @param token - An administrator's session.
 * @param operations - The operations.
 * @returns The response.
 */
const applied = Effect.fn("ConditionFields.applied")(function* applied(
  token: string,
  operations: readonly Operation[]
) {
  const response = yield* postChangeSet(token, operations);

  assert.strictEqual(response.status, 201, response.text);

  return response;
});

/**
 * A `PATCH` of an asset at its current version.
 * @param token - The session token.
 * @param id - The record.
 * @param body - Field values.
 * @returns The response.
 */
const patchCurrent = Effect.fn("ConditionFields.patchCurrent")(
  function* patchCurrent(
    token: string,
    id: string,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const version = (yield* rootVersion(id)) ?? 0;

    return yield* patch(token, ASSET, id, version, body);
  }
);

/**
 * The single `InvalidValue` of a refused write.
 * @param response - The response.
 * @returns Its field, reason and hint.
 */
const refusalOf = Effect.fn("ConditionFields.refusalOf")(function* refusalOf(
  response: TestResponse
) {
  assert.strictEqual(response.status, 422, response.text);

  const body = yield* decodeValidation(response.json).pipe(Effect.orDie);

  return body.fieldErrors.map((error) => ({
    field: error.field,
    reason: error.reason ?? error._tag,
  }));
});

/**
 * The `matches` condition field on `acme.asset`, conditions on
 * `acme.asset`, and an access rule letting employees write it.
 * @param token - An administrator's session.
 * @returns The field's ID.
 */
const addMatches = Effect.fn("ConditionFields.addMatches")(function* addMatches(
  token: string
) {
  const snapshot = yield* (yield* Catalog).refresh;
  const employee = snapshot.roleByName("employee")?.id ?? "";

  const matches = addField(ACME.asset, MATCHES, {
    classId: ACME.asset,
    kind: "condition",
    profile: "filter",
  });

  yield* applied(token, [
    matches.op,
    addAccessRule(
      ACME.asset,
      [employee],
      {
        description: "employees may write matches",
        fields: [matches.id],
      },
      { actions: ["create", "update"] }
    ).op,
  ]);

  return matches.id;
});

const eq = (fieldId: string, value: JsonValue): JsonValue => ({
  left: { path: [fieldId] },
  op: "eq",
  right: { value },
});

describe("condition-fields", () => {
  it("names the field the tests add", () => {
    assert.strictEqual(MATCHES, "matches");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a condition value is checked against the field's class and profile on every write",
      () =>
        Effect.gen(function* checkedOnSave() {
          const { tokens } = yield* signInAll;
          const { alice: aliceUser, records } = yield* AcmeFixture;

          yield* addMatches(tokens.admin);

          // A field to retire: a retired field may not be named.
          const old = addField(ACME.asset, "old_tag", { kind: "text" });

          yield* applied(tokens.admin, [old.op]);
          yield* applied(tokens.admin, [
            { id: old.id, op: "retire", version: 1 },
          ]);

          const id = records.AM;

          const write = (value: JsonValue) =>
            patchCurrent(tokens.alice, id, { [MATCHES]: value });

          // Accepted: fields of the class, a one-hop path, context `me`.
          const valid: readonly JsonValue[] = [
            eq(ACME.name, "Alice monitor"),
            {
              args: [
                { arg: { path: [ACME.purchasedOn] }, op: "notEmpty" },
                {
                  left: { path: [ACME.cost] },
                  op: "gt",
                  right: { value: "10.5" },
                },
              ],
              op: "and",
            },
            {
              left: { path: ["6a373fb5-bd18-4d7f-b0b4-182470f5421e"] },
              op: "eq",
              right: { ctx: "me" },
            },
          ];

          for (const value of valid) {
            const saved = yield* write(value);

            assert.strictEqual(saved.status, 200, saved.text);
          }

          const stored = yield* resourceOf(
            yield* (yield* TestHttpClient).get(recordPath(ASSET, id), {
              token: tokens.alice,
            })
          );

          assert.deepStrictEqual(stored[MATCHES], valid.at(-1));

          const invalid: readonly (readonly [string, JsonValue, string])[] = [
            ["unknown field", eq(randomUUID(), "x"), "unknownField"],
            ["retired field", eq(old.id, "x"), "retiredField"],
            ["a laptop field", eq(ACME.serial, "SN-L"), "unknownField"],
            [
              "text has no order",
              { left: { path: [ACME.name] }, op: "lt", right: { value: "m" } },
              "operatorNotForType",
            ],
            [
              "a date that does not convert",
              eq(ACME.purchasedOn, "2024-13-45"),
              "invalidLiteral",
            ],
            [
              "changed is not in the filter profile",
              { arg: { path: [ACME.name] }, op: "changed" },
              "operatorNotAllowed",
            ],
            [
              "previous is not in the filter profile",
              {
                left: { image: "previous", path: [ACME.name] },
                op: "eq",
                right: { value: "x" },
              },
              "previousNotAllowed",
            ],
            [
              "myGroups is not in Step 1's filter profile",
              {
                left: { path: ["6a373fb5-bd18-4d7f-b0b4-182470f5421e"] },
                op: "in",
                right: { ctx: "myGroups" },
              },
              "contextNotAllowed",
            ],
            ["not an AST", { op: "nope" }, "malformed"],
          ];

          const before = (yield* rootVersion(id)) ?? 0;

          for (const [label, value, issue] of invalid) {
            const refused = yield* write(value);

            assert.deepStrictEqual(
              yield* refusalOf(refused),
              [{ field: MATCHES, reason: "invalidCondition" }],
              label
            );

            const body = yield* decodeValidation(refused.json).pipe(
              Effect.orDie
            );

            assert.include(body.fieldErrors[0]?.hint ?? "", issue, label);
          }

          assert.strictEqual(yield* rootVersion(id), before);

          // Creates are checked the same way.
          const createdBad = yield* create(tokens.alice, ASSET, {
            [MATCHES]: eq(old.id, "x"),
            name: "with a bad condition",
            owner: aliceUser.id,
          });

          assert.deepStrictEqual(yield* refusalOf(createdBad), [
            { field: MATCHES, reason: "invalidCondition" },
          ]);

          const createdGood = yield* create(tokens.alice, ASSET, {
            [MATCHES]: eq(ACME.name, "x"),
            name: "with a condition",
            owner: aliceUser.id,
          });

          assert.strictEqual(createdGood.status, 201, createdGood.text);
        })
    );

    dbTest.effect(
      "a field the caller cannot read is unknown in his conditions, exactly like one that does not exist",
      () =>
        Effect.gen(function* hiddenField() {
          const { tokens } = yield* signInAll;
          const { records } = yield* AcmeFixture;
          const id = records.M;

          const write = (token: string, value: JsonValue) =>
            patchCurrent(token, id, { [MATCHES]: value });

          // cost is never readable to Bob (rule 5); compare with an ID that
          // names nothing, in the same position.
          const hidden = yield* write(tokens.bob, eq(ACME.cost, "10"));
          const missing = yield* write(tokens.bob, eq(randomUUID(), "10"));

          assert.deepStrictEqual(yield* refusalOf(hidden), [
            { field: MATCHES, reason: "invalidCondition" },
          ]);
          assert.strictEqual(hidden.status, missing.status);
          assert.strictEqual(hidden.text, missing.text);
          assert.notInclude(hidden.text, ACME.cost);
          assert.notInclude(hidden.text, "cost");

          // A field Bob can read on some records (purchased_on, rule 6) and
          // one he always reads are accepted.
          for (const value of [
            eq(ACME.purchasedOn, "2024-01-01"),
            eq(ACME.name, "M"),
          ]) {
            const saved = yield* write(tokens.bob, value);

            assert.strictEqual(saved.status, 200, saved.text);
          }

          // Alice reads cost: the same condition is hers to store.
          const alice = yield* write(tokens.alice, eq(ACME.cost, "10"));

          assert.strictEqual(alice.status, 200, alice.text);
        })
    );

    dbTest.effect(
      "a rename changes no stored condition; a retired field's conditions stay until the field is written again",
      () =>
        Effect.gen(function* renameAndRetire() {
          const { tokens } = yield* signInAll;
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const id = records.K;
          const grade = addField(ACME.asset, "grade", { kind: "text" });

          yield* applied(tokens.admin, [grade.op]);

          const condition = eq(grade.id, "a");

          const read = http
            .get(recordPath(ASSET, id), { token: tokens.alice })
            .pipe(Effect.flatMap(resourceOf));

          const write = (body: Readonly<Record<string, JsonValue>>) =>
            patchCurrent(tokens.alice, id, body);

          assert.strictEqual(
            (yield* write({ [MATCHES]: condition })).status,
            200
          );

          // Rename: the stored value names the field by ID and is unchanged.
          yield* applied(tokens.admin, [
            {
              id: grade.id,
              name: "level",
              op: "rename",
              version: yield* definitionVersion(grade.id),
            },
          ]);

          assert.deepStrictEqual((yield* read)[MATCHES], condition);
          assert.strictEqual(
            (yield* write({ [MATCHES]: eq(grade.id, "b") })).status,
            200
          );

          // Retire: the stored value stays as it is.
          const current = eq(grade.id, "b");

          yield* applied(tokens.admin, [
            {
              id: grade.id,
              op: "retire",
              version: yield* definitionVersion(grade.id),
            },
          ]);

          const after = yield* read;

          assert.deepStrictEqual(after[MATCHES], current);

          // A whole-record form re-sends it unchanged: not written, accepted.
          const unchanged = yield* write({
            [MATCHES]: current,
            name: "K renamed",
          });

          assert.strictEqual(unchanged.status, 200, unchanged.text);

          // Writing it again, changed, checks it: the retired field is refused.
          const rewritten = yield* write({ [MATCHES]: eq(grade.id, "c") });

          assert.deepStrictEqual(yield* refusalOf(rewritten), [
            { field: MATCHES, reason: "invalidCondition" },
          ]);
          assert.deepStrictEqual((yield* read)[MATCHES], current);
        })
    );

    dbTest.effect(
      "through the change-set endpoint a condition field keeps its class from being retired",
      () =>
        Effect.gen(function* conditionOn() {
          const { tokens } = yield* signInAll;

          yield* ensureSite;

          const area = createClass("area", { namespaceId: SITE_NAMESPACE_ID });

          const rule = addField(ACME.asset, "area_rule", {
            classId: area.id,
            kind: "condition",
            profile: "filter",
          });

          yield* applied(tokens.admin, [area.op, rule.op]);

          const retireArea = Effect.gen(function* retireAreaOp() {
            return yield* postChangeSet(tokens.admin, [
              {
                id: area.id,
                op: "retire",
                version: yield* definitionVersion(area.id),
              },
            ]);
          });

          const refused = yield* retireArea;

          assert.strictEqual(refused.status, 409, refused.text);
          assert.strictEqual(yield* codeOf(refused), "DependencyConflict");
          assert.include(refused.text, rule.id);

          // Retire the condition field first; then the class may go.
          yield* applied(tokens.admin, [
            {
              id: rule.id,
              op: "retire",
              version: yield* definitionVersion(rule.id),
            },
          ]);

          const retired = yield* retireArea;

          assert.strictEqual(retired.status, 201, retired.text);

          // The field cannot come back, and no new one may name the class.
          const reactivated = yield* postChangeSet(tokens.admin, [
            {
              id: rule.id,
              op: "reactivate",
              version: yield* definitionVersion(rule.id),
            },
          ]);

          assert.strictEqual(reactivated.status, 409, reactivated.text);
          assert.strictEqual(yield* codeOf(reactivated), "DependencyConflict");

          const another = yield* postChangeSet(tokens.admin, [
            addField(ACME.asset, "area_rule_2", {
              classId: area.id,
              kind: "condition",
              profile: "filter",
            }).op,
          ]);

          assert.strictEqual(another.status, 422, another.text);
          assert.strictEqual(yield* codeOf(another), "DefinitionInvalid");

          // Only filter conditions can be stored on a record.
          const ruleProfile = yield* postChangeSet(tokens.admin, [
            addField(ACME.asset, "access_like", {
              classId: ACME.asset,
              kind: "condition",
              profile: "accessRule",
            }).op,
          ]);

          assert.strictEqual(ruleProfile.status, 422, ruleProfile.text);
          assert.strictEqual(yield* codeOf(ruleProfile), "DefinitionInvalid");
        })
    );
  });
});
