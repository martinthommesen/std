/**
 * A reference field's allowed-records condition (decision 0020; plan Step
 * 2, "Reference picker limited to visible targets and the field's
 * allowed-records condition"; Contracts 3.6, 5.10, 6.4, 6.5).
 *
 * The acme set gains, through change sets in this test's database, a
 * reference `dock` on `acme.asset` targeting assets, limited by a
 * condition, which employees (Bob) may write, and a reference
 * `dock_laptop` targeting laptops. The fixture's records: Bob's L (laptop,
 * cost 1200, in use), M (monitor, 300, in use) and S (2500, lost); Alice's
 * AM (monitor, 400, in use) and K (laptop, 1800, in use). Bob never reads
 * `cost`.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { AccessRuleDraft } from "@std/definitions/definition";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { arrayOf, objectOf, signInAll, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { ACME, addField, change } from "./schema-support.ts";

const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const local = { owner: { layer: "local" }, protected: false } as const;

const PICKER = "acme.asset/dock";

/**
 * A condition on one asset field.
 *
 * @param fieldId - The field.
 * @param op - The comparison.
 * @param value - The literal.
 * @returns The AST.
 */
const compare = (fieldId: string, op: "eq" | "gt", value: string) => ({
  left: { path: [fieldId] },
  op,
  right: { value },
});

const IN_USE = compare(ACME.status, "eq", "in_use");
const COSTLY = compare(ACME.cost, "gt", "1000");

/** What the setup adds. */
interface Added {
  readonly dock: string;
}

const setup = Effect.gen(function* setupAllowedRecords() {
  const dock = addField(ACME.asset, "dock", {
    allowedRecords: IN_USE,
    kind: "reference",
    targetClassId: ACME.asset,
  });

  const dockLaptop = addField(ACME.asset, "dock_laptop", {
    kind: "reference",
    targetClassId: ACME.laptop,
  });

  yield* change([dock.op, dockLaptop.op]);

  const writeDock: AccessRuleDraft = {
    ...local,
    actions: ["create", "update"],
    active: true,
    classId: ACME.asset,
    condition: null,
    description: "employees may set dock",
    effect: "allow",
    id: randomUUID(),
    kind: "accessRule",
    name: null,
    roleIds: [EMPLOYEE],
    target: { fields: [dock.id], kind: "fields" },
  };

  yield* change([{ definition: writeDock, op: "createAccessRule" }]);

  return { dock: dock.id } satisfies Added;
});

/**
 * Sets the condition of `dock`.
 *
 * @param dockId - The field.
 * @param condition - The new condition.
 */
const limitDock = Effect.fn("AllowedRecords.limitDock")(function* limitDock(
  dockId: string,
  condition: JsonValue
) {
  const field = (yield* (yield* Catalog).refresh).field(dockId);

  yield* change([
    {
      changes: {
        type: {
          allowedRecords: condition,
          kind: "reference",
          targetClassId: ACME.asset,
        },
      },
      id: dockId,
      op: "update",
      version: field?.version ?? 0,
    },
  ]);
});

const namesOf = (response: TestResponse): string[] =>
  arrayOf(objectOf(response.json).records).map((record) =>
    textOf(objectOf(objectOf(record).values).name)
  );

// The body without its revision.
const bodyOf = (response: TestResponse): string =>
  response.text.replace(/"schemaRevision":\d+/u, '"schemaRevision":0');

const patchDock = (token: string, id: string, target: string, version = 1) =>
  Effect.gen(function* patchDockRequest() {
    const http = yield* TestHttpClient;

    return yield* http.request("PATCH", recordPath("acme.asset", id), {
      body: { dock: target },
      headers: { "if-match": `"${version}"` },
      token,
    });
  });

const versionOf = (token: string, id: string) =>
  Effect.gen(function* readVersion() {
    const http = yield* TestHttpClient;
    const response = yield* http.get(recordPath("acme.asset", id), { token });

    return Number(objectOf(objectOf(response.json).record).version);
  });

// A refusal's status, tag and parameter.
const tagAndParameter = (response: TestResponse) => [
  response.status,
  textOf(objectOf(response.json)._tag),
  textOf(objectOf(response.json).parameter ?? ""),
];

describe("allowed-records", () => {
  it("names the picker's field as table/field", () => {
    assert.strictEqual(PICKER.split("/").length, 2);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the picker list equals the plain list filtered by the condition, through the target and its descendants",
      () =>
        Effect.gen(function* pickerEqualsFilter() {
          yield* setup;

          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          for (const token of [tokens.alice, tokens.bob, tokens.admin]) {
            for (const table of ["acme.asset", "acme.laptop", "acme.monitor"]) {
              for (const filter of [
                undefined,
                'name starts with "L"',
                'not (name = "M")',
              ]) {
                const base = {
                  allowedFor: PICKER,
                  count: "true",
                  sort: "name",
                };

                const query = filter === undefined ? base : { ...base, filter };

                const picked = yield* http.get(listPath(table, query), {
                  token,
                });

                const plain = yield* http.get(
                  listPath(table, {
                    count: "true",
                    filter:
                      filter === undefined
                        ? 'status = "in_use"'
                        : `(${filter}) and status = "in_use"`,
                    sort: "name",
                  }),
                  { token }
                );

                assert.strictEqual(picked.status, 200, picked.text);
                assert.strictEqual(bodyOf(picked), bodyOf(plain), table);
                assert.notInclude(picked.text, "allowedRecords");
              }
            }
          }

          // The condition removes Bob's lost asset S.
          const bob = yield* http.get(
            listPath("acme.asset", { allowedFor: PICKER, sort: "name" }),
            { token: tokens.bob }
          );

          assert.deepStrictEqual(namesOf(bob), ["L", "M"]);

          // Metadata never shows the condition, to anyone.
          for (const token of [tokens.bob, tokens.admin]) {
            const meta = yield* http.get("/api/v1/meta/tables/acme.asset", {
              token,
            });

            const dock = arrayOf(
              objectOf(objectOf(meta.json).table).fields
            ).find((field) => objectOf(field).name === "dock");

            assert.deepStrictEqual(objectOf(dock).type, {
              kind: "reference",
              target: "acme.asset",
            });
            assert.notInclude(meta.text, "allowedRecords");
          }
        })
    );

    dbTest.effect(
      "a target outside the condition is InvalidReference, identical to an unknown ID, and writes nothing",
      () =>
        Effect.gen(function* writeCheck() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const { bob, records } = yield* AcmeFixture;
          const before = yield* committedState;

          const outside = yield* patchDock(tokens.bob, records.M, records.S);
          const unknown = yield* patchDock(tokens.bob, records.M, randomUUID());

          assert.strictEqual(outside.status, 422, outside.text);
          assert.strictEqual(outside.text, unknown.text);
          assert.strictEqual(
            outside.headers.get("content-type"),
            unknown.headers.get("content-type")
          );

          const create = (dock: string) =>
            http.request("POST", listPath("acme.asset"), {
              body: { dock, name: "new", owner: bob.id },
              token: tokens.bob,
            });

          const createdOutside = yield* create(records.S);

          assert.strictEqual(createdOutside.status, 422);
          assert.strictEqual(
            createdOutside.text,
            (yield* create(randomUUID())).text
          );
          assert.deepStrictEqual(yield* committedState, before);

          // Inside the condition, the same write succeeds.
          const inside = yield* patchDock(tokens.bob, records.M, records.L);

          assert.strictEqual(inside.status, 200, inside.text);
        })
    );

    dbTest.effect(
      "an unchanged value is kept after the condition stops allowing it",
      () =>
        Effect.gen(function* unchangedKept() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const { records } = yield* AcmeFixture;

          const dockId =
            (yield* (yield* Catalog).refresh).fieldByName(ACME.asset, "dock")
              ?.id ?? "";

          // M is docked to L (previous test); now only spare assets qualify.
          yield* limitDock(dockId, compare(ACME.status, "eq", "spare"));

          const version = yield* versionOf(tokens.bob, records.M);

          const kept = yield* http.request(
            "PATCH",
            recordPath("acme.asset", records.M),
            {
              body: { dock: records.L, name: "M" },
              headers: { "if-match": `"${version}"` },
              token: tokens.bob,
            }
          );

          assert.strictEqual(kept.status, 200, kept.text);

          const renamed = yield* http.request(
            "PATCH",
            recordPath("acme.asset", records.M),
            {
              body: { dock: records.L, name: "M2" },
              headers: { "if-match": `"${version}"` },
              token: tokens.bob,
            }
          );

          assert.strictEqual(renamed.status, 200, renamed.text);

          // A newly written target must qualify.
          const refused = yield* patchDock(
            tokens.bob,
            records.L,
            records.M,
            yield* versionOf(tokens.bob, records.L)
          );

          assert.strictEqual(refused.status, 422, refused.text);
          assert.include(refused.text, "InvalidReference");

          yield* http.request("PATCH", recordPath("acme.asset", records.M), {
            body: { name: "M" },
            headers: {
              "if-match": `"${yield* versionOf(tokens.bob, records.M)}"`,
            },
            token: tokens.bob,
          });
        })
    );

    dbTest.effect(
      "a condition reading a field Bob cannot read behaves for Bob as if it were empty, in the picker and the write check",
      () =>
        Effect.gen(function* nonInterference() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const { records } = yield* AcmeFixture;

          const dockId =
            (yield* (yield* Catalog).refresh).fieldByName(ACME.asset, "dock")
              ?.id ?? "";

          // M starts undocked, so setting L is a written value.
          const cleared = yield* http.request(
            "PATCH",
            recordPath("acme.asset", records.M),
            {
              body: { dock: null },
              headers: {
                "if-match": `"${yield* versionOf(tokens.bob, records.M)}"`,
              },
              token: tokens.bob,
            }
          );

          assert.strictEqual(cleared.status, 200, cleared.text);

          const observe = Effect.gen(function* observeBob() {
            const picked = yield* http.get(
              listPath("acme.asset", { allowedFor: PICKER, sort: "name" }),
              { token: tokens.bob }
            );

            const written = yield* patchDock(
              tokens.bob,
              records.M,
              records.L,
              yield* versionOf(tokens.bob, records.M)
            );

            return {
              picked: bodyOf(picked),
              written: written.status,
              writtenTag: textOf(objectOf(written.json)._tag ?? "ok"),
            };
          });

          // `cost > 1000`: empty for Bob, so nothing qualifies for him,
          // L included (cost 1200); Alice sees K, L and S.
          yield* limitDock(dockId, COSTLY);

          const alice = yield* http.get(
            listPath("acme.asset", { allowedFor: PICKER, sort: "name" }),
            { token: tokens.alice }
          );

          assert.deepStrictEqual(namesOf(alice), ["K", "L", "S"]);

          const costly = yield* observe;

          assert.deepStrictEqual(
            {
              picked: costly.picked.includes('"records":[]'),
              written: costly.written,
            },
            { picked: true, written: 422 }
          );

          // Changing L's hidden cost changes nothing Bob sees.
          const lVersion = yield* versionOf(tokens.alice, records.L);

          const cheaper = yield* http.request(
            "PATCH",
            recordPath("acme.asset", records.L),
            {
              body: { cost: "100.00" },
              headers: { "if-match": `"${lVersion}"` },
              token: tokens.alice,
            }
          );

          assert.strictEqual(cheaper.status, 200, cheaper.text);
          assert.deepStrictEqual(yield* observe, costly);

          // `not (cost > 1000)`: true for Bob on every record.
          yield* limitDock(dockId, { arg: COSTLY, op: "not" });

          const negated = yield* http.get(
            listPath("acme.asset", { allowedFor: PICKER, sort: "name" }),
            { token: tokens.bob }
          );

          assert.deepStrictEqual(namesOf(negated), ["L", "M", "S"]);
        })
    );

    dbTest.effect(
      "allowedFor names what the caller can name, a reference to the endpoint or an ancestor, or is refused",
      () =>
        Effect.gen(function* allowedForErrors() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const before = yield* committedState;

          const as = (table: string, allowedFor: string, token = tokens.bob) =>
            http.get(listPath(table, { allowedFor }), { token });

          for (const malformed of [
            "acme.asset",
            "/dock",
            "acme.asset/",
            "acme.asset/dock/x",
          ]) {
            assert.deepStrictEqual(
              tagAndParameter(yield* as("acme.asset", malformed)),
              [400, "InvalidRequest", "allowedFor"],
              malformed
            );
          }

          // Not a reference; a reference whose target is a descendant of
          // the endpoint.
          for (const wrong of ["acme.asset/name", "acme.asset/dock_laptop"]) {
            assert.deepStrictEqual(
              tagAndParameter(yield* as("acme.asset", wrong)),
              [400, "InvalidRequest", "allowedFor"],
              wrong
            );
          }

          assert.strictEqual(
            (yield* as("acme.laptop", "acme.asset/dock_laptop")).status,
            200
          );

          // A table or field the caller cannot name is unknown, exactly as
          // a missing one.
          const hiddenTable = yield* as("acme.asset", "core.change/fields");
          const missingTable = yield* as("acme.asset", "acme.nosuch/fields");

          assert.strictEqual(hiddenTable.status, 404);
          assert.strictEqual(
            hiddenTable.text.replace("core.change", "<t>"),
            missingTable.text.replace("acme.nosuch", "<t>")
          );

          const hiddenField = yield* as("acme.asset", "acme.asset/cost");
          const missingField = yield* as("acme.asset", "acme.asset/nosuch");

          assert.strictEqual(hiddenField.status, 400);
          assert.strictEqual(
            hiddenField.text.replace('"cost"', "<f>"),
            missingField.text.replace('"nosuch"', "<f>")
          );
          assert.deepStrictEqual(yield* committedState, before);
        })
    );

    dbTest.effect(
      "a change of the condition after R is relevant to a picker built at R",
      () =>
        Effect.gen(function* stalePicker() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const catalog = yield* Catalog;
          const stated = revisionHeaderValue(yield* catalog.refresh);

          const dockId =
            (yield* catalog.refresh).fieldByName(ACME.asset, "dock")?.id ?? "";

          const read = (allowedFor?: string) => {
            const query =
              allowedFor === undefined
                ? { fields: "name" }
                : { allowedFor, fields: "name" };

            return http.get(listPath("acme.asset", query), {
              headers: { "std-schema-revision": stated },
              token: tokens.bob,
            });
          };

          assert.strictEqual((yield* read(PICKER)).status, 200);

          yield* limitDock(dockId, IN_USE);

          const stale = yield* read(PICKER);

          assert.strictEqual(stale.status, 409, stale.text);
          assert.deepStrictEqual(
            arrayOf(objectOf(stale.json).changes).map((entry) => [
              objectOf(entry).field,
              objectOf(entry).kind,
            ]),
            [["dock", "settingsChanged"]]
          );
          assert.strictEqual((yield* read()).status, 200);
        })
    );
  });
});
