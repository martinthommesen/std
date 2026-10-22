/**
 * `tmf630-conformance` (Contracts 10): one test per rule of 10.1 to 10.6
 * against the acme fixture: paths and names, the resource representation,
 * `fields`, each filter form, paging and counts, `sort`, polymorphic
 * create, merge-patch and JSON Patch, `204` on delete, `ETag`, the TMF
 * `Error` shape, history, sessions and table metadata.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ACME, AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { mergePatch } from "../src/http/v2/patch.ts";
import { TMF_ERROR_TAGS, tmfErrorOf } from "../src/http/v2/tmf-error.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  asArray,
  asObject,
  idsOf,
  numberOf,
  textOf,
  V2,
  v2Callers,
  withQuery,
} from "./v2-support.ts";

const ORIGIN = "http://localhost";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

const linkRels = (response: TestResponse): string[] =>
  [...(response.headers.get("link") ?? "").matchAll(/rel="(?<rel>\w+)"/gu)].map(
    (match) => match.groups?.rel ?? ""
  );

const linkOf = (response: TestResponse, rel: string): string => {
  const entry = (response.headers.get("link") ?? "")
    .split(", ")
    .find((part) => part.endsWith(`rel="${rel}"`));

  return (entry ?? "")
    .replace(/^<http:\/\/localhost/u, "")
    .replace(/>;.*$/u, "");
};

const namesOf = (response: TestResponse): string[] =>
  asArray(response.json).map((item) => textOf(asObject(item).name));

const patchOptions = (
  caller: TestRequestOptions,
  revision: number,
  contentType: string,
  body: JsonValue
): TestRequestOptions => ({
  ...caller,
  headers: { "content-type": contentType, "if-match": `"${revision}"` },
  rawBody: JSON.stringify(body),
});

/**
 * A fresh asset of Alice's through v2, for the write tests.
 *
 * @param caller - The signed-in caller.
 * @param body - The asset's attributes.
 * @returns The created resource.
 */
const freshAsset = (
  caller: TestRequestOptions,
  body: JsonObject
): Effect.Effect<JsonObject, never, TestHttpClient> =>
  Effect.gen(function* createAsset() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", V2.asset, {
      ...caller,
      body,
    });

    assert.strictEqual(created.status, 201, created.text);

    return asObject(created.json);
  });

describe("tmf630-conformance", () => {
  it("merges json values by RFC 7396", () => {
    assert.deepStrictEqual(
      mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: 5 }),
      { a: 1, b: { d: 3, e: 4 }, f: 5 }
    );
    assert.deepStrictEqual(mergePatch(null, { a: { b: 1 } }), { a: { b: 1 } });
    assert.strictEqual(mergePatch({ a: 1 }, "x"), "x");
  });

  it("gives every error tag a TMF Error with code, reason, @type and a string status", () => {
    for (const tag of TMF_ERROR_TAGS) {
      const { body, status } = tmfErrorOf({ _tag: tag });

      assert.strictEqual(body.code, tag);
      assert.strictEqual(body["@type"], tag);
      assert.strictEqual(body["@baseType"], "Error");
      assert.strictEqual(body.status, String(status));
      assert.isTrue(isJsonString(body.reason ?? null));
      assert.strictEqual(
        body["@schemaLocation"],
        `/api/v2/openapi.json#/components/schemas/${tag}`
      );
    }

    assert.strictEqual(tmfErrorOf({ _tag: "VersionConflict" }).status, 412);
    assert.strictEqual(tmfErrorOf({ _tag: "VersionRequired" }).status, 428);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a table is a lowerCamelCase collection; qualified names are not paths",
      () =>
        Effect.gen(function* collections() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const response = yield* http.get(V2.asset, callers.alice);

          assert.strictEqual(response.status, 200, response.text);
          assert.sameMembers(idsOf(response), Object.values(records));

          const qualified = yield* http.get(
            "/api/v2/acme.asset",
            callers.alice
          );

          assert.strictEqual(qualified.status, 404);
          assert.strictEqual(codeOf(qualified), "UnknownTable");
          assert.strictEqual(asObject(qualified.json).table, "acme.asset");
        })
    );

    dbTest.effect(
      "a resource is flat with id, href, @type, @baseType, @schemaLocation and API names",
      () =>
        Effect.gen(function* representation() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const response = yield* http.get(
            `${V2.laptop}/${records.L}`,
            callers.alice
          );

          const laptop = asObject(response.json);

          assert.strictEqual(response.status, 200, response.text);
          assert.strictEqual(laptop.id, records.L);
          assert.strictEqual(laptop.href, `${ORIGIN}${V2.laptop}/${records.L}`);
          assert.strictEqual(laptop["@type"], "AcmeLaptop");
          assert.strictEqual(laptop["@baseType"], "AcmeAsset");
          assert.strictEqual(
            laptop["@schemaLocation"],
            `${ORIGIN}/api/v2/tableMetadata/acmeLaptop/schema.json`
          );
          assert.strictEqual(laptop.purchasedOn, "2025-01-15");
          assert.strictEqual(laptop.cost, "1200.00");
          assert.isNumber(laptop.revision);
          assert.isString(laptop.creationDate);
          assert.notProperty(laptop, "purchased_on");
          assert.notProperty(laptop, "version");
          assert.notProperty(laptop, "class");

          // Every attribute name is lowerCamelCase or an @ attribute.
          for (const name of Object.keys(laptop)) {
            assert.match(name, /^(?:@[a-z][A-Za-z]*|[a-z][A-Za-z\d]*)$/u);
          }

          // The href dereferences to the same resource.
          const again = yield* http.get(
            textOf(laptop.href).replace(ORIGIN, ""),
            callers.alice
          );

          assert.strictEqual(again.text, response.text);
          assert.strictEqual(
            response.headers.get("etag"),
            `"${numberOf(laptop.revision)}"`
          );

          const root = asObject(
            (yield* http.get(`${V2.asset}/${records.S}`, callers.alice)).json
          );

          assert.strictEqual(root["@type"], "AcmeAsset");
          assert.notProperty(root, "@baseType");
        })
    );

    dbTest.effect(
      "a record read through a parent collection names its own URI",
      () =>
        Effect.gen(function* parentRead() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const response = yield* http.get(
            `${V2.asset}/${records.L}`,
            callers.alice
          );

          const laptop = asObject(response.json);

          assert.strictEqual(laptop["@type"], "AcmeLaptop");
          assert.strictEqual(
            response.headers.get("content-location"),
            `${ORIGIN}${V2.laptop}/${records.L}`
          );
          // The concrete representation, child fields included (Martin, D1).
          assert.strictEqual(laptop.serial, "SN-L");
        })
    );

    dbTest.effect(
      "references are EntityRefs; a label only under 3.6; empty attributes absent; withheld listed",
      () =>
        Effect.gen(function* references() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { alice, bob, records } = yield* AcmeFixture;

          const asAlice = asObject(
            (yield* http.get(`${V2.laptop}/${records.L}`, callers.alice)).json
          );

          assert.deepStrictEqual(asAlice.dockedTo, {
            "@referredType": "AcmeMonitor",
            "@type": "AcmeAssetRef",
            href: `${ORIGIN}${V2.monitor}/${records.AM}`,
            id: records.AM,
            name: "Alice monitor",
          });
          assert.deepInclude(asObject(asAlice.owner), {
            "@referredType": "CoreUser",
            "@type": "CoreUserRef",
            id: bob.id,
          });

          // Bob cannot see Alice's monitor: no label, and its class is the
          // declared target's.
          const asBob = asObject(
            (yield* http.get(`${V2.laptop}/${records.L}`, callers.bob)).json
          );

          assert.deepStrictEqual(asBob.dockedTo, {
            "@referredType": "AcmeAsset",
            "@type": "AcmeAssetRef",
            href: `${ORIGIN}${V2.asset}/${records.AM}`,
            id: records.AM,
          });
          assert.notProperty(asBob, "cost");

          // S is lost: purchased_on is withheld from Bob (rule 6), and M
          // has no docking (empty, so absent).
          const lost = asObject(
            (yield* http.get(`${V2.asset}/${records.S}`, callers.bob)).json
          );

          assert.include(asArray(lost.withheld), "purchasedOn");
          assert.notProperty(lost, "purchasedOn");

          const monitor = asObject(
            (yield* http.get(`${V2.monitor}/${records.M}`, callers.bob)).json
          );

          assert.notProperty(monitor, "dockedTo");
          assert.notProperty(monitor, "withheld");
          assert.strictEqual(alice.id === bob.id, false);
        })
    );

    dbTest.effect(
      "fields selects attributes and paths; none, !name and conflicts",
      () =>
        Effect.gen(function* fields() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;
          const path = `${V2.laptop}/${records.L}`;

          const named = asObject(
            (yield* http.get(
              withQuery(path, [["fields", "name"]]),
              callers.alice
            )).json
          );

          assert.sameMembers(Object.keys(named), [
            "id",
            "href",
            "@type",
            "@baseType",
            "@schemaLocation",
            "revision",
            "name",
          ]);

          const none = asObject(
            (yield* http.get(
              withQuery(path, [["fields", "none"]]),
              callers.alice
            )).json
          );

          assert.notProperty(none, "name");
          assert.property(none, "href");

          const excluded = asObject(
            (yield* http.get(
              withQuery(path, [["fields", "!cost"]]),
              callers.alice
            )).json
          );

          assert.notProperty(excluded, "cost");
          assert.property(excluded, "name");

          const conflict = yield* http.get(
            withQuery(path, [["fields", "cost,!cost"]]),
            callers.alice
          );

          assert.strictEqual(conflict.status, 409);
          assert.strictEqual(codeOf(conflict), "FieldsConflict");

          const hop = asObject(
            (yield* http.get(
              withQuery(path, [["fields", "dockedTo.status"]]),
              callers.alice
            )).json
          );

          assert.deepInclude(asObject(hop.dockedTo), {
            id: records.AM,
            status: "in_use",
          });
        })
    );

    dbTest.effect(
      "attribute filters: eq, in by comma, semicolon and repeats",
      () =>
        Effect.gen(function* equality() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const eq = yield* http.get(
            withQuery(V2.asset, [["status", "lost"]]),
            callers.alice
          );

          assert.deepStrictEqual(namesOf(eq), ["S"]);

          for (const query of [
            [["name", "K,L"]],
            [["name", "K;L"]],
            [
              ["name", "K"],
              ["name", "L"],
            ],
          ] as const) {
            const listed = yield* http.get(
              withQuery(V2.asset, query),
              callers.alice
            );

            assert.sameMembers(namesOf(listed), ["K", "L"]);
          }

          // TMF filters compare text unmodified (Martin, D4); the
          // condition extension keeps the field's case behavior.
          const exact = yield* http.get(
            withQuery(V2.asset, [["name", "k"]]),
            callers.alice
          );

          assert.strictEqual(exact.status, 200);
          assert.deepStrictEqual(namesOf(exact), []);

          const folded = yield* http.get(
            withQuery(V2.asset, [["condition", 'name = "k"']]),
            callers.alice
          );

          assert.deepStrictEqual(namesOf(folded), ["K"]);
        })
    );

    dbTest.effect(
      "comparisons in dot and URL-encoded forms, references, @type and condition",
      () =>
        Effect.gen(function* comparisons() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { alice, records } = yield* AcmeFixture;

          const forms: readonly (readonly [string, string])[] = [
            ["cost.gte", "1200"],
            ["cost>=", "1200"],
          ];

          for (const form of forms) {
            const listed = yield* http.get(
              withQuery(V2.asset, [form]),
              callers.alice
            );

            assert.sameMembers(namesOf(listed), ["S", "K", "L"]);
          }

          const range = yield* http.get(
            withQuery(V2.asset, [
              ["cost.gt", "300"],
              ["cost.lt", "1800"],
            ]),
            callers.alice
          );

          assert.sameMembers(namesOf(range), ["Alice monitor", "L"]);

          const lte = yield* http.get(
            withQuery(V2.asset, [["cost<=", "300"]]),
            callers.alice
          );

          assert.deepStrictEqual(namesOf(lte), ["M"]);

          const owned = yield* http.get(
            withQuery(V2.asset, [["owner.id", alice.id]]),
            callers.alice
          );

          assert.sameMembers(idsOf(owned), [records.AM, records.K]);

          const hop = yield* http.get(
            withQuery(V2.asset, [["dockedTo.name", "Alice monitor"]]),
            callers.alice
          );

          assert.deepStrictEqual(idsOf(hop), [records.L]);

          const typed = yield* http.get(
            withQuery(V2.asset, [["@type", "AcmeLaptop,AcmeMonitor"]]),
            callers.alice
          );

          assert.sameMembers(namesOf(typed), ["K", "L", "M", "Alice monitor"]);

          const condition = yield* http.get(
            withQuery(V2.asset, [
              ["condition", 'purchasedOn > "2025-01-01"'],
              ["status", "in_use"],
            ]),
            callers.alice
          );

          assert.sameMembers(namesOf(condition), ["Alice monitor", "K", "L"]);

          const escaped = yield* http.get(
            withQuery(V2.asset, [[".status", "lost"]]),
            callers.alice
          );

          assert.deepStrictEqual(namesOf(escaped), ["S"]);
        })
    );

    dbTest.effect(
      "refused filters: hidden equals missing, .regex, empty values, unknown parameters, JSONPath",
      () =>
        Effect.gen(function* refusedFilters() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const hidden = yield* http.get(
            withQuery(V2.asset, [["cost", "1"]]),
            callers.bob
          );

          const missing = yield* http.get(
            withQuery(V2.asset, [["nosuchfield", "1"]]),
            callers.bob
          );

          assert.strictEqual(hidden.status, 400);
          assert.strictEqual(codeOf(hidden), "UnknownField");
          assert.strictEqual(
            hidden.text.replace("cost", "X"),
            missing.text.replace("nosuchfield", "X")
          );

          const regex = yield* http.get(
            withQuery(V2.asset, [["name.regex", "~K"]]),
            callers.alice
          );

          assert.strictEqual(codeOf(regex), "InvalidFilter");

          const empty = yield* http.get(
            withQuery(V2.asset, [["name", ""]]),
            callers.alice
          );

          assert.strictEqual(codeOf(empty), "InvalidFilter");

          const unknown = yield* http.get(
            withQuery(V2.asset, [["@foo", "1"]]),
            callers.alice
          );

          assert.strictEqual(unknown.status, 400);
          assert.strictEqual(codeOf(unknown), "InvalidRequest");

          const jsonPath = yield* http.get(
            withQuery(V2.asset, [["filter", "$[?(@.name=='K')]"]]),
            callers.alice
          );

          assert.strictEqual(jsonPath.status, 501);
          assert.strictEqual(codeOf(jsonPath), "NotImplemented");
        })
    );

    dbTest.effect(
      "offset pages carry both counts and self, first, next, prev and last links",
      () =>
        Effect.gen(function* offsetPages() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const first = yield* http.get(
            withQuery(V2.asset, [
              ["sort", "name"],
              ["limit", "2"],
              ["offset", "0"],
              ["count", "false"],
            ]),
            callers.alice
          );

          assert.strictEqual(first.status, 200);
          assert.strictEqual(first.headers.get("x-result-count"), "2");
          assert.strictEqual(first.headers.get("x-total-count"), "5");
          assert.sameMembers(linkRels(first), [
            "self",
            "first",
            "next",
            "last",
          ]);

          const second = yield* http.get(linkOf(first, "next"), callers.alice);

          assert.strictEqual(second.headers.get("x-result-count"), "2");
          assert.sameMembers(linkRels(second), [
            "self",
            "first",
            "prev",
            "next",
            "last",
          ]);

          const last = yield* http.get(linkOf(first, "last"), callers.alice);

          assert.deepStrictEqual(namesOf(last), ["S"]);

          const past = yield* http.get(
            withQuery(V2.asset, [["offset", "99"]]),
            callers.alice
          );

          assert.strictEqual(past.status, 200);
          assert.deepStrictEqual(asArray(past.json), []);

          for (const [name, value] of [
            ["offset", "-1"],
            ["limit", "0"],
            ["limit", "1001"],
          ] as const) {
            const refused = yield* http.get(
              withQuery(V2.asset, [[name, value]]),
              callers.alice
            );

            assert.strictEqual(refused.status, 400, name);
          }
        })
    );

    dbTest.effect(
      "cursor pages: after, before and both; count=false drops the total",
      () =>
        Effect.gen(function* cursorPages() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const sorted = [["sort", "-cost,+name"]] as const;

          const all = namesOf(
            yield* http.get(withQuery(V2.asset, sorted), callers.alice)
          );

          assert.deepStrictEqual(all, ["S", "K", "L", "Alice monitor", "M"]);

          const page = yield* http.get(
            withQuery(V2.asset, [...sorted, ["limit", "2"]]),
            callers.alice
          );

          assert.sameMembers(linkRels(page), ["self", "next"]);
          assert.strictEqual(page.headers.get("x-total-count"), "5");

          const next = yield* http.get(linkOf(page, "next"), callers.alice);

          assert.deepStrictEqual(namesOf(next), ["L", "Alice monitor"]);
          assert.sameMembers(linkRels(next), ["self", "prev", "next"]);

          const previous = yield* http.get(linkOf(next, "prev"), callers.alice);

          assert.deepStrictEqual(namesOf(previous), ["S", "K"]);

          const uncounted = yield* http.get(
            `${linkOf(page, "next")}&count=false`,
            callers.alice
          );

          assert.isNull(uncounted.headers.get("x-total-count"));
          assert.strictEqual(uncounted.headers.get("x-result-count"), "2");

          const mixed = yield* http.get(
            `${linkOf(page, "next")}&offset=1`,
            callers.alice
          );

          assert.strictEqual(codeOf(mixed), "InvalidRequest");
        })
    );

    dbTest.effect("history is a list of ChangeEntry resources", () =>
      Effect.gen(function* history() {
        const http = yield* TestHttpClient;
        const callers = yield* v2Callers;
        const { records } = yield* AcmeFixture;

        const response = yield* http.get(
          `${V2.laptop}/${records.L}/history`,
          callers.alice
        );

        const [entry] = asArray(response.json).map(asObject);

        assert.strictEqual(response.status, 200, response.text);
        assert.strictEqual(response.headers.get("x-result-count"), "1");
        assert.strictEqual(entry?.["@type"], "ChangeEntry");
        assert.strictEqual(entry?.["@baseType"], "History");
        assert.strictEqual(entry?.action, "created");
        assert.strictEqual(entry?.revision, 1);
        assert.property(asObject(entry?.changes), "purchasedOn");
        assert.strictEqual(asObject(entry?.revisedBy)["@type"], "CoreUserRef");
      })
    );

    dbTest.effect("sessions: create, read and end at /api/v2/session", () =>
      Effect.gen(function* sessions() {
        const http = yield* TestHttpClient;

        const created = yield* http.request("POST", "/api/v2/session", {
          body: {
            login: "bob",
            password: "bob-password",
            tokenDelivery: "body",
          },
        });

        const session = asObject(created.json);

        assert.strictEqual(created.status, 201, created.text);
        assert.strictEqual(
          created.headers.get("location"),
          `${ORIGIN}/api/v2/session/current`
        );
        assert.isString(session.token);

        const token = textOf(session.token);
        const current = yield* http.get("/api/v2/session/current", { token });

        assert.strictEqual(current.status, 200);
        assert.strictEqual(asObject(current.json).name, "Bob");

        const cookie = yield* http.request("POST", "/api/v2/session", {
          body: {
            login: "bob",
            password: "bob-password",
            tokenDelivery: "cookie",
          },
        });

        assert.notProperty(asObject(cookie.json), "token");
        assert.match(cookie.headers.get("set-cookie") ?? "", /Path=\/api;/u);

        const ended = yield* http.request("DELETE", "/api/v2/session/current", {
          token,
        });

        assert.strictEqual(ended.status, 204);

        const after = yield* http.get("/api/v2/session/current", { token });

        assert.strictEqual(after.status, 401);
        assert.strictEqual(codeOf(after), "Unauthenticated");

        const wrong = yield* http.request("POST", "/api/v2/session", {
          body: { login: "bob", password: "nope" },
        });

        assert.strictEqual(codeOf(wrong), "InvalidCredentials");
      })
    );

    dbTest.effect(
      "table metadata: the list, a table with API names, and its JSON Schema",
      () =>
        Effect.gen(function* metadata() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const list = yield* http.get("/api/v2/tableMetadata", callers.bob);

          assert.include(idsOf(list), "acmeAsset");

          const table = asObject(
            (yield* http.get("/api/v2/tableMetadata/acmeLaptop", callers.alice))
              .json
          );

          const apiNames = asArray(table.fields).map(
            (field) => asObject(field).apiName
          );

          assert.include(apiNames, "purchasedOn");
          assert.include(apiNames, "diskKey");

          const schema = yield* http.get(
            "/api/v2/tableMetadata/acmeAsset/schema.json",
            callers.bob
          );

          const properties = asObject(asObject(schema.json).properties);

          assert.strictEqual(schema.status, 200);
          assert.property(properties, "dockedTo");
          assert.notProperty(properties, "cost");
          assert.strictEqual(asObject(schema.json).title, "AcmeAsset");

          const openApi = yield* http.get("/api/v2/openapi.json");

          assert.strictEqual(openApi.status, 200);
          assert.strictEqual(asObject(openApi.json).openapi, "3.1.0");
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "create: 201 with Location and ETag; polymorphic create through a parent",
      () =>
        Effect.gen(function* creates() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { alice } = yield* AcmeFixture;

          const created = yield* http.request("POST", V2.asset, {
            ...callers.alice,
            body: { name: "New", owner: { id: alice.id }, status: "spare" },
          });

          const asset = asObject(created.json);

          assert.strictEqual(created.status, 201, created.text);
          assert.strictEqual(
            created.headers.get("location"),
            textOf(asset.href)
          );
          assert.strictEqual(
            created.headers.get("etag"),
            `"${numberOf(asset.revision)}"`
          );

          const laptop = yield* http.request("POST", V2.asset, {
            ...callers.alice,
            body: {
              "@type": "AcmeLaptop",
              name: "Child",
              purchasedOn: "2026-01-01",
              serial: "SN-C",
            },
          });

          assert.strictEqual(laptop.status, 201, laptop.text);
          assert.strictEqual(asObject(laptop.json)["@type"], "AcmeLaptop");
          assert.strictEqual(asObject(laptop.json).serial, "SN-C");

          const outside = yield* http.request("POST", V2.laptop, {
            ...callers.alice,
            body: { "@type": "AcmeMonitor", name: "X" },
          });

          assert.strictEqual(codeOf(outside), "InvalidRequest");

          const readOnly = yield* http.request("POST", V2.asset, {
            ...callers.alice,
            body: {
              creationDate: "2026-01-01T00:00:00.000Z",
              id: alice.id,
              name: "X",
            },
          });

          assert.strictEqual(readOnly.status, 422);
          assert.deepStrictEqual(
            asArray(asObject(readOnly.json).fieldErrors).map(
              (error) => asObject(error).field
            ),
            ["creationDate", "id"]
          );

          const wrongType = yield* http.request("POST", V2.asset, {
            ...callers.alice,
            body: {
              dockedTo: { "@referredType": "CoreUser", id: alice.id },
              name: "X",
            },
          });

          assert.strictEqual(codeOf(wrongType), "InvalidReference");
        })
    );

    dbTest.effect(
      "merge-patch: If-Match required, 412 when stale, 200 with ETag; unchanged @type accepted",
      () =>
        Effect.gen(function* mergePatches() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const asset = yield* freshAsset(callers.alice, {
            name: "P",
            status: "spare",
          });

          const path = `${V2.asset}/${textOf(asset.id)}`;

          const missing = yield* http.request("PATCH", path, {
            ...callers.alice,
            headers: { "content-type": "application/merge-patch+json" },
            rawBody: JSON.stringify({ status: "in_use" }),
          });

          assert.strictEqual(missing.status, 428);
          assert.strictEqual(codeOf(missing), "VersionRequired");

          const patched = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 1, "application/merge-patch+json", {
              "@type": "AcmeAsset",
              status: "in_use",
            })
          );

          assert.strictEqual(patched.status, 200, patched.text);
          assert.strictEqual(asObject(patched.json).status, "in_use");
          assert.strictEqual(patched.headers.get("etag"), '"2"');

          const stale = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 1, "application/merge-patch+json", {
              status: "spare",
            })
          );

          assert.strictEqual(stale.status, 412);
          assert.strictEqual(codeOf(stale), "VersionConflict");
          assert.strictEqual(stale.headers.get("etag"), '"2"');

          const otherType = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 2, "application/merge-patch+json", {
              "@type": "AcmeLaptop",
            })
          );

          assert.strictEqual(codeOf(otherType), "ValidationFailed");

          const cleared = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 2, "application/json", { status: null })
          );

          assert.strictEqual(cleared.status, 200, cleared.text);
          assert.notProperty(asObject(cleared.json), "status");
        })
    );

    dbTest.effect(
      "JSON Patch: every operation, a failed test writes nothing, read-only paths refused",
      () =>
        Effect.gen(function* jsonPatches() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          const asset = yield* freshAsset(callers.alice, {
            name: "J",
            status: "spare",
          });

          const path = `${V2.asset}/${textOf(asset.id)}`;
          const jsonPatch = "application/json-patch+json";

          const applied = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 1, jsonPatch, [
              { op: "test", path: "/status", value: "spare" },
              { op: "replace", path: "/status", value: "in_use" },
              { op: "add", path: "/purchasedOn", value: "2026-02-01" },
              { from: "/name", op: "copy", path: "/status" },
              { from: "/purchasedOn", op: "move", path: "/purchasedOn" },
            ])
          );

          const result = asObject(applied.json);

          assert.strictEqual(applied.status, 200, applied.text);
          assert.strictEqual(result.status, "J");
          assert.strictEqual(result.purchasedOn, "2026-02-01");

          const removed = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 2, jsonPatch, [
              { op: "remove", path: "/purchasedOn" },
            ])
          );

          assert.notProperty(asObject(removed.json), "purchasedOn");

          const failed = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 3, jsonPatch, [
              { op: "replace", path: "/name", value: "changed" },
              { op: "test", path: "/status", value: "nope" },
            ])
          );

          assert.strictEqual(failed.status, 409);
          assert.strictEqual(codeOf(failed), "PatchTestFailed");

          const unchanged = asObject(
            (yield* http.get(path, callers.alice)).json
          );

          assert.strictEqual(unchanged.name, "J");
          assert.strictEqual(unchanged.revision, 3);

          const readOnly = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 3, jsonPatch, [
              { op: "replace", path: "/id", value: RANDOM_ID },
            ])
          );

          assert.strictEqual(codeOf(readOnly), "ValidationFailed");

          const malformed = yield* http.request(
            "PATCH",
            path,
            patchOptions(callers.alice, 3, jsonPatch, [
              { op: "fly", path: "/x" },
            ])
          );

          assert.strictEqual(malformed.status, 400);

          const query = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.alice,
              3,
              "application/json-patch-query+json",
              []
            )
          );

          assert.strictEqual(query.status, 415);
          assert.strictEqual(codeOf(query), "UnsupportedMediaType");
        })
    );

    dbTest.effect("DELETE answers 204; a body is refused; PUT is 405", () =>
      Effect.gen(function* deletes() {
        const http = yield* TestHttpClient;
        const callers = yield* v2Callers;
        const asset = yield* freshAsset(callers.alice, { name: "D" });
        const path = `${V2.asset}/${textOf(asset.id)}`;

        const withBody = yield* http.request("DELETE", path, {
          ...callers.alice,
          headers: { "if-match": '"1"' },
          rawBody: "{}",
        });

        assert.strictEqual(withBody.status, 400);

        const put = yield* http.request("PUT", path, {
          ...callers.alice,
          body: {},
        });

        assert.strictEqual(put.status, 405);
        assert.strictEqual(
          put.headers.get("allow"),
          "GET, HEAD, PATCH, DELETE, OPTIONS"
        );

        const deleted = yield* http.request("DELETE", path, {
          ...callers.alice,
          headers: { "if-match": '"1"' },
        });

        assert.strictEqual(deleted.status, 204);
        assert.strictEqual(deleted.text, "");

        const gone = yield* http.get(path, callers.alice);

        assert.strictEqual(gone.status, 404);
        assert.strictEqual(codeOf(gone), "NotFound");
        assert.strictEqual(ACME.asset.length > 0, true);
      })
    );
  });
});
