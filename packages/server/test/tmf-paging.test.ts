import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { parseJson } from "@std/values/json";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { encodeCursor } from "../src/records/read-cursor.ts";
import { asArray, asObject, idsOf, textOf, withQuery } from "./api-support.ts";
import { hubTestLayer, listener } from "./hub-support.ts";
import { itilLayer } from "./itil-support.ts";
import { linksOf } from "./paging.ts";
import { readsTestLayer } from "./reads-support.ts";
import { TICKETS, ticketBody, tmf621As } from "./tmf621-support.ts";

type GetPage = (path: string) => Effect.Effect<TestResponse>;

const pageLinks = (page: TestResponse) => linksOf(page.headers.get("link"));

const linkedPath = (page: TestResponse, relation: string): string => {
  const link = pageLinks(page).get(relation);
  assert.isDefined(link, `${relation}: ${page.headers.get("link")}`);
  const url = new URL(link ?? "");

  return `${url.pathname}${url.search}`;
};

// Positions come from the HTTP interface, including the final row's prev cursor.
const positionsOf = Effect.fn("PagingTest.positions")(function* positionsOf(
  get: GetPage,
  path: string,
  expected: readonly string[]
) {
  const positions: string[] = [];
  let next = path;

  for (const id of expected) {
    const page = yield* get(next);
    assert.strictEqual(page.status, 200, page.text);
    assert.deepStrictEqual(idsOf(page), [id]);
    const relation = pageLinks(page).has("next") ? "next" : "prev";
    const url = new URL(pageLinks(page).get(relation) ?? "");
    positions.push(
      url.searchParams.get(relation === "next" ? "after" : "before") ?? ""
    );

    if (relation === "next") {
      next = linkedPath(page, "next");
    }
  }

  return positions;
});

const proveRange = Effect.fn("PagingTest.range")(function* proveRange(
  get: GetPage,
  path: string,
  expected: readonly string[]
) {
  const positions = yield* positionsOf(get, path, expected);
  const [after = ""] = positions;
  const before = positions.at(-1) ?? "";
  const rangePath = `${path}&${new URLSearchParams({ after, before }).toString()}`;
  const pages: TestResponse[] = [];
  let next = rangePath;

  for (const id of expected.slice(1, -1)) {
    const page = yield* get(next);
    assert.strictEqual(page.status, 200, page.text);
    assert.deepStrictEqual(idsOf(page), [id]);
    assert.strictEqual(page.headers.get("x-result-count"), "1");
    assert.strictEqual(
      page.headers.get("x-total-count"),
      String(expected.length)
    );
    pages.push(page);

    if (pageLinks(page).has("next")) {
      next = linkedPath(page, "next");
    }
  }

  const first = pages.at(0);
  const last = pages.at(-1);

  if (first === undefined || last === undefined) {
    return yield* Effect.die(new Error("Expected a bounded traversal"));
  }

  const escaped = {
    afterLast: pageLinks(last).has("next")
      ? idsOf(yield* get(linkedPath(last, "next")))
      : [],
    beforeFirst: pageLinks(first).has("prev")
      ? idsOf(yield* get(linkedPath(first, "prev")))
      : [],
  };

  assert.deepStrictEqual(
    escaped,
    { afterLast: [], beforeFirst: [] },
    JSON.stringify(escaped)
  );

  assert.isFalse(
    pageLinks(last).has("next"),
    "The final bounded page must omit next"
  );
  assert.isFalse(
    pageLinks(first).has("prev"),
    "The first bounded page must omit prev"
  );

  // Follow every advertised direction, then switch direction on its destination.
  for (const [index, page] of pages.entries()) {
    for (const [relation, step] of [
      ["prev", -1],
      ["next", 1],
    ] as const) {
      if (!pageLinks(page).has(relation)) {
        continue;
      }

      const adjacent = yield* get(linkedPath(page, relation));
      assert.strictEqual(adjacent.status, 200, adjacent.text);
      assert.deepStrictEqual(idsOf(adjacent), [expected[index + step + 1]]);

      const returned = yield* get(
        linkedPath(adjacent, step === 1 ? "prev" : "next")
      );

      assert.deepStrictEqual(idsOf(returned), idsOf(page));
    }
  }

  for (const [lower, upper] of [
    [after, after],
    [before, after],
  ]) {
    const empty = yield* get(
      `${path}&${new URLSearchParams({ after: lower ?? "", before: upper ?? "" }).toString()}`
    );

    assert.strictEqual(empty.status, 200, empty.text);
    assert.deepStrictEqual(idsOf(empty), []);
    assert.deepStrictEqual([...pageLinks(empty).keys()], ["self"]);
  }

  return rangePath;
});

describe("TMF paging", () => {
  it("unbounded cursors retain their documented position-only encoding", () => {
    const id = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
    assert.strictEqual(
      Buffer.from(encodeCursor([], { id, values: [] }), "base64url").toString(
        "utf-8"
      ),
      '{"i":"01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f","k":[],"s":[]}'
    );
  });
  it.effect(
    "record range links preserve both exclusive bounds across three pages in both directions",
    () =>
      Effect.gen(function* range() {
        const http = yield* TestHttpClient;
        const caller = { token: yield* http.signIn("alice", "alice-password") };
        const { records } = yield* AcmeFixture;

        const path = yield* proveRange(
          (uri) => http.get(uri, caller),
          "/api/v1/acmeAsset?sort=name&fields=name&limit=1",
          [records.AM, records.K, records.L, records.M, records.S]
        );

        const uncounted = yield* http.get(`${path}&count=false`, caller);
        assert.strictEqual(uncounted.status, 200, uncounted.text);
        assert.isNull(uncounted.headers.get("x-total-count"));
        assert.deepStrictEqual(idsOf(uncounted), [records.K]);

        const bounded = yield* http.get(path, caller);
        const continuation = new URL(pageLinks(bounded).get("next") ?? "");

        const parsed = parseJson(
          Buffer.from(
            continuation.searchParams.get("after") ?? "",
            "base64url"
          ).toString("utf-8")
        );

        if (!parsed.ok) {
          throw new Error("Expected a JSON cursor issued by the server");
        }

        const cursor = asObject(parsed.value);
        const interval = asObject(cursor.range);

        for (const invalidRange of [
          {
            ...interval,
            after: { ...asObject(interval.after), i: "not-a-uuid" },
          },
          { ...interval, before: { ...asObject(interval.before), k: [] } },
        ]) {
          continuation.searchParams.set(
            "after",
            Buffer.from(
              JSON.stringify({ ...cursor, range: invalidRange })
            ).toString("base64url")
          );

          const invalid = yield* http.get(
            `${continuation.pathname}${continuation.search}`,
            caller
          );

          assert.strictEqual(invalid.status, 400, invalid.text);
          assert.strictEqual(asObject(invalid.json).code, "InvalidCursor");
        }
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "filtered cursor ends omit empty adjacent pages and malformed cursors fail with 400",
    () =>
      Effect.gen(function* ends() {
        const http = yield* TestHttpClient;
        const caller = { token: yield* http.signIn("bob", "bob-password") };
        const { records } = yield* AcmeFixture;
        const get = (path: string) => http.get(path, caller);
        const path = "/api/v1/acmeAsset?sort=name&fields=name&limit=1";

        const positions = yield* positionsOf(get, path, [
          records.L,
          records.M,
          records.S,
        ]);

        const [first = "", second = ""] = positions;
        const last = positions.at(-1) ?? "";

        for (const [direction, position, name, expected, absent] of [
          ["after", first, "M", records.M, "prev"],
          ["before", last, "M", records.M, "next"],
          ["before", last, "L", records.L, "prev"],
        ] as const) {
          const page = yield* get(
            `${path}&${new URLSearchParams({ [direction]: position, name }).toString()}`
          );

          assert.strictEqual(page.status, 200, page.text);
          assert.deepStrictEqual(idsOf(page), [expected]);
          assert.isFalse(pageLinks(page).has(absent));

          for (const relation of ["next", "prev"]) {
            if (pageLinks(page).has(relation)) {
              assert.isNotEmpty(idsOf(yield* get(linkedPath(page, relation))));
            }
          }
        }

        for (const params of [
          { after: last },
          { before: first },
          { after: second, name: "L" },
        ]) {
          const empty = yield* get(
            `${path}&${new URLSearchParams(params).toString()}`
          );

          assert.strictEqual(empty.status, 200, empty.text);
          assert.deepStrictEqual(idsOf(empty), []);
          assert.deepStrictEqual([...pageLinks(empty).keys()], ["self"]);
        }

        for (const direction of ["after", "before"]) {
          const invalid = yield* get(`${path}&${direction}=malformed`);
          assert.strictEqual(invalid.status, 400, invalid.text);
          assert.strictEqual(asObject(invalid.json).code, "InvalidCursor");
        }
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "nullable masked sort keys retain real adjacent pages in both directions",
    () =>
      Effect.gen(function* maskedSort() {
        const http = yield* TestHttpClient;
        const caller = { token: yield* http.signIn("bob", "bob-password") };
        const { records } = yield* AcmeFixture;
        const get = (path: string) => http.get(path, caller);

        for (const [sort, ordered, direction, relation] of [
          ["purchasedOn", [records.M, records.L, records.S], "before", "next"],
          ["-purchasedOn", [records.S, records.L, records.M], "after", "prev"],
        ] as const) {
          const path = withQuery("/api/v1/acmeAsset", [
            ["sort", sort],
            ["fields", "name,purchasedOn"],
            ["limit", "1"],
          ]);

          const positions = yield* positionsOf(get, path, ordered);

          const page = yield* get(
            `${path}&${new URLSearchParams({ [direction]: positions[1] ?? "", name: "M,S" }).toString()}`
          );

          assert.strictEqual(page.status, 200, page.text);
          assert.deepStrictEqual(idsOf(page), [records.M]);
          assert.strictEqual(page.headers.get("x-total-count"), "2");

          const adjacent = yield* get(linkedPath(page, relation));

          assert.strictEqual(adjacent.status, 200, adjacent.text);
          assert.deepStrictEqual(idsOf(adjacent), [records.S]);
          assert.notProperty(
            asObject(asArray(adjacent.json)[0]),
            "purchasedOn"
          );
          assert.include(
            asArray(asObject(asArray(adjacent.json)[0]).withheld),
            "purchasedOn"
          );
        }
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "TMF621 range links preserve both bounds across three pages and filtered ends",
    () =>
      Effect.gen(function* mapped() {
        const client = yield* tmf621As("admin");
        const ids: string[] = [];

        for (const name of [
          "Paging A",
          "Paging B",
          "Paging C",
          "Paging D",
          "Paging E",
        ]) {
          const created = yield* client.post(TICKETS, ticketBody({ name }));
          assert.strictEqual(created.status, 201, created.text);
          ids.push(textOf(asObject(created.json).id));
        }

        const path = withQuery(TICKETS, [
          ["name", "Paging A,Paging B,Paging C,Paging D,Paging E"],
          ["sort", "name"],
          ["fields", "name"],
          ["limit", "1"],
        ]);

        yield* proveRange(client.get, path, ids);
        const positions = yield* positionsOf(client.get, path, ids);

        const single = yield* client.get(
          withQuery(TICKETS, [
            ["name", "Paging C"],
            ["sort", "name"],
            ["after", positions[0] ?? ""],
            ["limit", "1"],
          ])
        );

        assert.strictEqual(single.status, 200, single.text);
        assert.deepStrictEqual(idsOf(single), ids.slice(2, 3));
        assert.deepStrictEqual([...pageLinks(single).keys()], ["self"]);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "TMF688 offset lists emit self first next prev last links with filters and selection",
    () =>
      Effect.gen(function* offset() {
        const http = yield* TestHttpClient;
        const caller = { token: yield* http.signIn("ada", "ada-password") };
        const path = `${TMF688_PREFIX}/topic`;
        const createdIds: string[] = [];

        for (const name of [
          "Paging topic A",
          "Paging topic B",
          "Paging topic C",
        ]) {
          const created = yield* http.request("POST", path, {
            ...caller,
            body: { headerQuery: "paging", name },
          });

          assert.strictEqual(created.status, 201, created.text);
          createdIds.push(textOf(asObject(created.json).id));
        }

        const listed = yield* http.get(
          `${path}?headerQuery=paging&fields=name&offset=0&limit=1`,
          caller
        );

        assert.strictEqual(listed.status, 200, listed.text);
        assert.sameMembers(
          [...pageLinks(listed).keys()],
          ["self", "first", "next", "last"]
        );
        const middle = yield* http.get(linkedPath(listed, "next"), caller);
        assert.sameMembers(
          [...pageLinks(middle).keys()],
          ["self", "first", "next", "prev", "last"]
        );
        const last = yield* http.get(linkedPath(middle, "next"), caller);
        assert.sameMembers(
          [...pageLinks(last).keys()],
          ["self", "first", "prev", "last"]
        );
        assert.sameMembers(
          [...idsOf(listed), ...idsOf(middle), ...idsOf(last)],
          createdIds
        );

        for (const page of [listed, middle, last]) {
          assert.strictEqual(page.headers.get("x-total-count"), "3");
          assert.strictEqual(page.headers.get("x-result-count"), "1");

          for (const [relation, link] of pageLinks(page)) {
            const url = new URL(link);
            assert.strictEqual(url.searchParams.get("headerQuery"), "paging");
            assert.strictEqual(url.searchParams.get("fields"), "name");
            assert.strictEqual(url.searchParams.get("limit"), "1");
            assert.isFalse(url.searchParams.has("after"));

            const adjacent = yield* http.get(
              linkedPath(page, relation),
              caller
            );

            assert.strictEqual(adjacent.status, 200, adjacent.text);
            assert.lengthOf(asArray(adjacent.json), 1);
            assert.notProperty(
              asObject(asArray(adjacent.json)[0]),
              "headerQuery"
            );
          }
        }

        assert.deepStrictEqual(
          idsOf(yield* http.get(linkedPath(last, "prev"), caller)),
          idsOf(middle)
        );

        const pastEnd = yield* http.get(
          `${path}?headerQuery=paging&fields=name&offset=10&limit=1`,
          caller
        );

        assert.strictEqual(pastEnd.status, 200, pastEnd.text);
        assert.deepStrictEqual(idsOf(pastEnd), []);
        assert.deepStrictEqual(
          idsOf(yield* http.get(linkedPath(pastEnd, "prev"), caller)),
          idsOf(last)
        );

        const empty = yield* http.get(
          `${path}?headerQuery=absent&offset=10&limit=1`,
          caller
        );

        assert.strictEqual(empty.status, 200, empty.text);
        assert.deepStrictEqual(idsOf(empty), []);
        assert.isFalse(pageLinks(empty).has("prev"));
        assert.isFalse(pageLinks(empty).has("next"));

        for (const parameter of ["after", "before"]) {
          const refused = yield* http.get(
            `${path}?${parameter}=opaque`,
            caller
          );

          assert.strictEqual(refused.status, 400, refused.text);
        }

        const eventBefore = yield* http.get(
          `${path}/${createdIds[0] ?? ""}/event?before=opaque`,
          caller
        );

        assert.strictEqual(eventBefore.status, 400, eventBefore.text);
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "TMF688 topic hub offset links visit nonempty adjacent pages and retain callback selection",
    () =>
      Effect.gen(function* hubs() {
        const http = yield* TestHttpClient;
        const caller = { token: yield* http.signIn("ada", "ada-password") };

        const topic = yield* http.request("POST", `${TMF688_PREFIX}/topic`, {
          ...caller,
          body: { name: "Paging hubs" },
        });

        assert.strictEqual(topic.status, 201, topic.text);
        const path = `${TMF688_PREFIX}/topic/${textOf(asObject(topic.json).id)}/hub`;
        const callback = yield* listener();
        const registered: string[] = [];

        for (const name of ["a", "b", "c"]) {
          const hub = yield* http.request("POST", path, {
            ...caller,
            body: { callback: `${callback.origin}/paging/${name}` },
          });

          assert.strictEqual(hub.status, 201, hub.text);
          registered.push(textOf(asObject(hub.json).id));
        }

        let next = `${path}?offset=0&limit=1&fields=callback`;
        const found: string[] = [];

        for (const index of [0, 1, 2]) {
          const page = yield* http.get(next, caller);
          assert.strictEqual(page.status, 200, page.text);
          assert.strictEqual(page.headers.get("x-total-count"), "3");
          assert.strictEqual(page.headers.get("x-result-count"), "1");
          found.push(...idsOf(page));
          assert.isString(asObject(asArray(page.json)[0]).callback);
          assert.sameMembers(
            [...pageLinks(page).keys()],
            [
              "self",
              "first",
              "last",
              ...(index > 0 ? ["prev"] : []),
              ...(index < 2 ? ["next"] : []),
            ]
          );

          for (const [relation, link] of pageLinks(page)) {
            const url = new URL(link);
            assert.strictEqual(url.pathname, path);
            assert.strictEqual(url.searchParams.get("fields"), "callback");
            assert.isFalse(url.searchParams.has("after"));

            const adjacent = yield* http.get(
              linkedPath(page, relation),
              caller
            );

            assert.strictEqual(adjacent.status, 200, adjacent.text);
            assert.lengthOf(idsOf(adjacent), 1);
          }

          if (index < 2) {
            next = linkedPath(page, "next");
          }
        }

        assert.sameMembers(found, registered);
      }).pipe(Effect.provide(hubTestLayer), TestClock.withLive)
  );
});
