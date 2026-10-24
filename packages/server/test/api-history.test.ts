/**
 * `v2-history` (Contracts 10.4; TMF630 v5.0.0 Part 1 §12): the history of a
 * record at `/api/v1/{table}/{id}/history` with paging, counts, links and
 * `ChangeEntry` filters, and one entry at `history/{changeId}`, all under
 * the per-caller filtering of Contracts 3.7.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { recordHref } from "../src/http/api/resource.ts";
import {
  assetWithHistory,
  UNKNOWN_ID,
  revisionsOf,
  asArray,
  asObject,
  textOf,
  API,
  apiCallers,
  withQuery,
} from "./api-support.ts";
import { linksOf } from "./paging.ts";
import { readsTestLayer } from "./reads-support.ts";

const revisionsChecked = (response: TestResponse): number[] => {
  assert.strictEqual(response.status, 200, response.text);

  return revisionsOf(response);
};

// History assertions select word-only navigation relations; version relations remain distinct.
const WORD_RELATION = /^\w+$/u;

const linkRels = (response: TestResponse): string[] =>
  [...linksOf(response.headers.get("link")).keys()].filter((relation) =>
    WORD_RELATION.test(relation)
  );

describe("api-history", () => {
  it("builds a record's URL from the origin and collection", () => {
    assert.strictEqual(
      `${recordHref("http://localhost", "acmeAsset", "abc")}/history/x`,
      "http://localhost/api/v1/acmeAsset/abc/history/x"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("pages with counts and links", () =>
      Effect.gen(function* paging() {
        const http = yield* TestHttpClient;

        const { alice: user } = yield* AcmeFixture;
        const alice = { token: yield* http.signIn(user.login, user.password) };
        const path = yield* assetWithHistory(alice, "H");

        const all = yield* http.get(`${path}/history`, alice);

        assert.strictEqual(all.status, 200, all.text);
        assert.deepStrictEqual(revisionsOf(all), [1, 2, 3]);
        assert.strictEqual(all.headers.get("x-total-count"), "3");
        assert.sameMembers(linkRels(all), ["self", "first", "last"]);

        const first = yield* http.get(
          withQuery(`${path}/history`, [["limit", "2"]]),
          alice
        );

        assert.deepStrictEqual(revisionsOf(first), [1, 2]);
        assert.strictEqual(first.headers.get("x-result-count"), "2");
        assert.strictEqual(first.headers.get("x-total-count"), "3");
        assert.sameMembers(linkRels(first), ["self", "first", "next", "last"]);

        const second = yield* http.get(
          withQuery(`${path}/history`, [
            ["limit", "2"],
            ["offset", "2"],
          ]),
          alice
        );

        assert.deepStrictEqual(revisionsOf(second), [3]);
        assert.sameMembers(linkRels(second), ["self", "first", "prev", "last"]);

        const past = yield* http.get(
          withQuery(`${path}/history`, [["offset", "50"]]),
          alice
        );

        assert.strictEqual(past.status, 200);
        assert.deepStrictEqual(revisionsOf(past), []);
        assert.strictEqual(past.headers.get("x-total-count"), "3");

        for (const bad of [
          ["offset", "-1"],
          ["limit", "0"],
          ["limit", "1001"],
          ["limit", "x"],
        ] as const) {
          const refused = yield* http.get(
            withQuery(`${path}/history`, [bad]),
            alice
          );

          assert.strictEqual(refused.status, 400, bad.join("="));
        }
      })
    );

    dbTest.effect("filters on ChangeEntry attributes", () =>
      Effect.gen(function* filtering() {
        const http = yield* TestHttpClient;

        const { alice: user } = yield* AcmeFixture;
        const alice = { token: yield* http.signIn(user.login, user.password) };
        const path = yield* assetWithHistory(alice, "H");

        const revisionsFor = (query: readonly (readonly [string, string])[]) =>
          http
            .get(withQuery(`${path}/history`, query), alice)
            .pipe(Effect.map(revisionsChecked));

        assert.deepStrictEqual(
          yield* revisionsFor([["action", "created"]]),
          [1]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["action", "created,updated"]]),
          [1, 2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["action", "created;deleted"]]),
          [1]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["kind", "update"]]),
          [2, 3]
        );
        assert.deepStrictEqual(yield* revisionsFor([["revision", "2"]]), [2]);
        assert.deepStrictEqual(
          yield* revisionsFor([["revision.gt", "1"]]),
          [2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["revision.gte", "2"]]),
          [2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["revision.lt", "3"]]),
          [1, 2]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["revision.lte", "1"]]),
          [1]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["revision>=", "2"]]),
          [2, 3]
        );
        assert.deepStrictEqual(yield* revisionsFor([["revision<", "2"]]), [1]);
        assert.deepStrictEqual(
          yield* revisionsFor([["creationDate.gt", "2000-01-01"]]),
          [1, 2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["creationDate.lt", "2000-01-01T00:00:00Z"]]),
          []
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["since", "2000-01-01T00:00:00Z"]]),
          [1, 2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["until", "2000-01-01T00:00:00Z"]]),
          []
        );

        const alicesId = textOf(
          asObject(
            asObject(
              asArray((yield* http.get(`${path}/history`, alice)).json)[0]
            ).revisedBy
          ).id
        );

        assert.deepStrictEqual(
          yield* revisionsFor([["revisedBy.id", alicesId]]),
          [1, 2, 3]
        );
        assert.deepStrictEqual(
          yield* revisionsFor([["actor.id", UNKNOWN_ID]]),
          []
        );

        const selected = yield* http.get(
          withQuery(`${path}/history`, [["fields", "revision"]]),
          alice
        );

        assert.deepStrictEqual(
          Object.keys(asObject(asArray(selected.json)[0])).toSorted(),
          ["@baseType", "@type", "href", "id", "revision"]
        );
      })
    );

    dbTest.effect("rejects unknown parameters", () =>
      Effect.gen(function* unknown() {
        const http = yield* TestHttpClient;

        const { alice: user } = yield* AcmeFixture;
        const alice = { token: yield* http.signIn(user.login, user.password) };
        const { records } = yield* AcmeFixture;

        const response = yield* http.get(
          withQuery(`${API.laptop}/${records.K}/history`, [["colour", "red"]]),
          alice
        );

        assert.strictEqual(response.status, 400);
        assert.strictEqual(asObject(response.json).code, "InvalidRequest");
        assert.include(response.text, "colour");
      })
    );

    dbTest.effect(
      "same-attribute fields conflicts reject both marker orders on history lists and reads",
      () =>
        Effect.gen(function* fieldConflicts() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const { records } = yield* AcmeFixture;

          for (const collection of [API.asset, API.laptop]) {
            const history = `${collection}/${records.L}/history`;
            const baseline = yield* http.get(history, alice);
            assert.strictEqual(baseline.status, 200, baseline.text);
            const entry = textOf(asObject(asArray(baseline.json)[0]).id);
            assert.notStrictEqual(entry, "");

            for (const [path, query] of [
              [history, []],
              [`${history}/${entry}`, []],
              [history, [["action", "deleted"]]],
              [history, [["offset", "50"]]],
            ] as const) {
              const unselected = yield* http.get(withQuery(path, query), alice);
              assert.strictEqual(unselected.status, 200, unselected.text);

              if (query.length > 0) {
                assert.deepStrictEqual(unselected.json, []);
              }

              for (const [included, excluded, field] of [
                ["action", "action", "action"],
                ["revision", "revision", "revision"],
                ["fields", "fields", "fields"],
                ["changes.name", "changes.cost", "changes"],
              ] as const) {
                for (const fields of [
                  `${included},!${excluded}`,
                  `!${excluded}, ${included}`,
                ]) {
                  const response = yield* http.get(
                    withQuery(path, [...query, ["fields", fields]]),
                    alice
                  );

                  assert.strictEqual(response.status, 409, response.text);
                  assert.deepStrictEqual(response.json, {
                    "@baseType": "Error",
                    "@schemaLocation":
                      "/api/v1/openapi.json#/components/schemas/FieldsConflict",
                    "@type": "FieldsConflict",
                    code: "FieldsConflict",
                    field,
                    message: "fields includes and excludes the same attribute",
                    reason: "fields includes and excludes the same attribute",
                    status: "409",
                  });
                }
              }
            }
          }
        })
    );

    dbTest.effect(
      "history fields preserve identity, distinct mixed markers and whole nested attributes",
      () =>
        Effect.gen(function* selections() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const { records } = yield* AcmeFixture;
          const history = `${API.laptop}/${records.L}/history`;
          const baseline = yield* http.get(history, alice);
          assert.strictEqual(baseline.status, 200, baseline.text);
          const entry = asObject(asArray(baseline.json)[0]);

          const {
            action = null,
            revision = null,
            changes = null,
            fields: descriptions = null,
            ...rest
          } = entry;

          assert.strictEqual(action, "created");
          assert.strictEqual(revision, 1);
          assert.property(asObject(changes), "name");
          assert.property(asObject(changes), "cost");
          assert.property(asObject(descriptions), "cost");

          const identity = {
            "@baseType": "History",
            "@type": "ChangeEntry",
            href: textOf(entry.href),
            id: textOf(entry.id),
          };

          for (const path of [history, `${history}/${textOf(entry.id)}`]) {
            for (const [selection, expected] of [
              ["none", identity],
              ["id,!id", identity],
              ["!id,id", identity],
              ["action,!kind", { ...identity, action }],
              ["!kind,action", { ...identity, action }],
              ["action,!id,!href,!@type,!@baseType", { ...identity, action }],
              ["revision", { ...identity, revision }],
              ["!action", { ...rest, changes, fields: descriptions, revision }],
              [
                "changes.name,fields.name",
                { ...identity, changes, fields: descriptions },
              ],
              [
                "revisedBy.id,entity.id,cause",
                {
                  ...identity,
                  cause: entry.cause ?? null,
                  entity: entry.entity ?? null,
                  revisedBy: entry.revisedBy ?? null,
                },
              ],
              ["!changes.name,!fields.name", { ...rest, action, revision }],
            ] as const) {
              const response = yield* http.get(
                withQuery(path, [["fields", selection]]),
                alice
              );

              assert.strictEqual(
                response.status,
                200,
                `${selection}: ${response.text}`
              );
              assert.deepStrictEqual(
                response.json,
                path === history ? [expected] : expected,
                selection
              );
            }

            for (const [attribute, value] of Object.entries(rest)) {
              const response = yield* http.get(
                withQuery(path, [["fields", attribute]]),
                alice
              );

              const expected = { ...identity, [attribute]: value };
              assert.strictEqual(response.status, 200, response.text);
              assert.deepStrictEqual(
                response.json,
                path === history ? [expected] : expected
              );
            }
          }
        })
    );

    dbTest.effect(
      "history fields reject malformed and unknown selectors before empty results",
      () =>
        Effect.gen(function* invalidSelections() {
          const http = yield* TestHttpClient;
          const { alice } = yield* apiCallers;
          const { records } = yield* AcmeFixture;
          const history = `${API.laptop}/${records.L}/history`;
          const baseline = yield* http.get(history, alice);
          assert.strictEqual(baseline.status, 200, baseline.text);
          const entry = textOf(asObject(asArray(baseline.json)[0]).id);
          assert.notStrictEqual(entry, "");

          for (const [path, query] of [
            [history, [["action", "deleted"]]],
            [`${history}/${entry}`, []],
          ] as const) {
            for (const selection of ["nosuchfield", "!nosuchfield", "cost"]) {
              const response = yield* http.get(
                withQuery(path, [...query, ["fields", selection]]),
                alice
              );

              assert.strictEqual(response.status, 400, response.text);
              assert.deepStrictEqual(response.json, {
                "@baseType": "Error",
                "@schemaLocation":
                  "/api/v1/openapi.json#/components/schemas/UnknownField",
                "@type": "UnknownField",
                code: "UnknownField",
                field: selection === "!nosuchfield" ? "nosuchfield" : selection,
                message: "No such field",
                reason: "No such field",
                status: "400",
              });
            }

            for (const selection of ["", "action,"]) {
              const response = yield* http.get(
                withQuery(path, [...query, ["fields", selection]]),
                alice
              );

              assert.strictEqual(response.status, 400, response.text);
              assert.deepStrictEqual(response.json, {
                "@baseType": "Error",
                "@schemaLocation":
                  "/api/v1/openapi.json#/components/schemas/InvalidRequest",
                "@type": "InvalidRequest",
                code: "InvalidRequest",
                message: "fields lists attribute names.",
                parameter: "fields",
                reason: "A request parameter is malformed",
                status: "400",
              });
            }
          }
        })
    );

    dbTest.effect(
      "history fields cannot widen record or changed-field authorization",
      () =>
        Effect.gen(function* authorizedSelections() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* apiCallers;
          const { records } = yield* AcmeFixture;

          for (const collection of [API.asset, API.laptop]) {
            const visible = `${collection}/${records.L}/history`;
            const baseline = yield* http.get(visible, bob);
            assert.strictEqual(baseline.status, 200, baseline.text);
            const entry = asObject(asArray(baseline.json)[0]);

            const expected = {
              "@baseType": "History",
              "@type": "ChangeEntry",
              changes: asObject(entry.changes),
              fields: asObject(entry.fields),
              href: textOf(entry.href),
              id: textOf(entry.id),
            };

            for (const path of [visible, `${visible}/${textOf(entry.id)}`]) {
              const response = yield* http.get(
                withQuery(path, [["fields", "changes.cost,fields.cost"]]),
                bob
              );

              assert.strictEqual(response.status, 200, response.text);
              assert.deepStrictEqual(
                response.json,
                path === visible ? [expected] : expected
              );
              assert.notProperty(asObject(entry.changes), "cost");
              assert.notProperty(asObject(entry.fields), "cost");
              assert.property(asObject(entry.changes), "name");
            }

            const hiddenHistory = `${collection}/${records.K}/history`;
            const hiddenList = yield* http.get(hiddenHistory, alice);
            assert.strictEqual(hiddenList.status, 200, hiddenList.text);
            const hiddenId = textOf(asObject(asArray(hiddenList.json)[0]).id);
            assert.notStrictEqual(hiddenId, "");

            for (const suffix of ["", `/${hiddenId}`]) {
              const missing = yield* http.get(
                `${collection}/${UNKNOWN_ID}/history${suffix}`,
                bob
              );

              const hidden = yield* http.get(
                withQuery(`${hiddenHistory}${suffix}`, [
                  ["fields", "changes.cost,fields.cost"],
                ]),
                bob
              );

              assert.strictEqual(hidden.status, 404, hidden.text);
              assert.strictEqual(hidden.text, missing.text);
              assert.isNull(hidden.headers.get("link"));
            }
          }
        })
    );

    dbTest.effect("serves one entry and refuses others identically", () =>
      Effect.gen(function* single() {
        const http = yield* TestHttpClient;
        const { alice, bob } = yield* apiCallers;
        const { records } = yield* AcmeFixture;

        const list = yield* http.get(
          `${API.laptop}/${records.K}/history`,
          alice
        );

        const entry = asObject(asArray(list.json)[0]);
        const href = textOf(entry.href);

        assert.strictEqual(
          href,
          `http://localhost${API.laptop}/${records.K}/history/${textOf(entry.id)}`
        );

        const found = yield* http.get(
          href.replace("http://localhost", ""),
          alice
        );

        assert.strictEqual(found.status, 200, found.text);
        assert.strictEqual(asObject(found.json).id, entry.id);
        assert.strictEqual(asObject(found.json)["@type"], "ChangeEntry");

        const missing = yield* http.get(
          `${API.laptop}/${records.K}/history/${UNKNOWN_ID}`,
          alice
        );

        const malformed = yield* http.get(
          `${API.laptop}/${records.K}/history/not-an-id`,
          alice
        );

        const hidden = yield* http.get(
          `${API.laptop}/${records.K}/history/${textOf(entry.id)}`,
          bob
        );

        const otherRecord = yield* http.get(
          `${API.laptop}/${records.L}/history/${textOf(entry.id)}`,
          alice
        );

        for (const refused of [missing, malformed, hidden, otherRecord]) {
          assert.strictEqual(refused.status, 404);
          assert.strictEqual(refused.text, missing.text);
        }
      })
    );

    dbTest.effect("never shows Bob a cost change", () =>
      Effect.gen(function* costs() {
        const http = yield* TestHttpClient;
        const { alice, bob } = yield* apiCallers;
        const { records } = yield* AcmeFixture;

        const asAlice = yield* http.get(
          `${API.laptop}/${records.L}/history`,
          alice
        );

        const asBob = yield* http.get(
          `${API.laptop}/${records.L}/history`,
          bob
        );

        assert.strictEqual(asBob.status, 200, asBob.text);

        for (const entry of asArray(asBob.json)) {
          const object: JsonObject = asObject(entry);

          assert.notProperty(asObject(object.changes), "cost");
          assert.notProperty(asObject(object.fields), "cost");
        }

        assert.isAbove(asArray(asAlice.json).length, 0);
      })
    );
  });
});
