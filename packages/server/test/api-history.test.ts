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
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { recordHref } from "../src/http/api/resource.ts";
import {
  MERGE_PATCH,
  UNKNOWN_ID,
  revisionsOf,
  patchOptions,
  asArray,
  asObject,
  textOf,
  API,
  apiCallers,
  withQuery,
} from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";

const revisionsChecked = (response: TestResponse): number[] => {
  assert.strictEqual(response.status, 200, response.text);

  return revisionsOf(response);
};

const linkRels = (response: TestResponse): string[] =>
  [...(response.headers.get("link") ?? "").matchAll(/rel="(?<rel>\w+)"/gu)].map(
    (match) => match.groups?.rel ?? ""
  );

/**
 * An asset of Alice's with three history entries: created, then two
 * updates.
 *
 * @param alice - Alice's request options.
 * @returns The asset's path.
 */
const assetWithHistory = (
  alice: TestRequestOptions
): Effect.Effect<string, never, TestHttpClient> =>
  Effect.gen(function* createHistory() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", API.asset, {
      ...alice,
      body: { name: "H", status: "spare" },
    });

    assert.strictEqual(created.status, 201, created.text);

    const path = `${API.asset}/${textOf(asObject(created.json).id)}`;

    for (const [revision, status] of [
      [1, "in_use"],
      [2, "spare"],
    ] as const) {
      const patched = yield* http.request(
        "PATCH",
        path,
        patchOptions(alice, MERGE_PATCH, { status }, `"${revision}"`)
      );

      assert.strictEqual(patched.status, 200, patched.text);
    }

    return path;
  });

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
        const path = yield* assetWithHistory(alice);

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
        const path = yield* assetWithHistory(alice);

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
