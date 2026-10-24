/** Dead-delivery cursor intervals, Contracts 4.6, 10.3–10.4; decision 0037. */
import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { ACME } from "../../testing/src/acme-ids.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { encodeCursor } from "../src/records/read-cursor.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { asArray, asObject, idsOf } from "./api-support.ts";
import { linksOf } from "./paging.ts";
import { readsTestLayer } from "./reads-support.ts";
import { addAccessRule } from "./schema-support.ts";

const COLLECTION = "/api/v1/deadDelivery";

type GetPage = (path: string) => Effect.Effect<TestResponse>;

const linkedUrl = (page: TestResponse, relation: string): URL => {
  const href = linksOf(page.headers.get("link")).get(relation);
  assert.isDefined(href, `${relation}: ${page.headers.get("link")}`);

  return new URL(href ?? "");
};

const linkedPath = (page: TestResponse, relation: string): string => {
  const url = linkedUrl(page, relation);

  return `${url.pathname}${url.search}`;
};

const fiveDeliveries = Effect.fn("DeadPagingTest.seed")(
  function* fiveDeliveries(admin: TestRequestOptions) {
    const seeded = yield* seedDeadLetters(admin);
    const http = yield* TestHttpClient;

    for (const version of [2, 3, 4]) {
      const updated = yield* http.request(
        "PATCH",
        `/api/v1/acmeAsset/${seeded.recordId}`,
        {
          ...admin,
          body: { name: `Dead paging version ${version + 1}` },
          headers: {
            "content-type": "application/merge-patch+json",
            "if-match": `"${version}"`,
          },
        }
      );

      assert.strictEqual(updated.status, 200, updated.text);
    }

    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE core.delivery SET status = 'dead', attempts = 1, finished_at = now() WHERE subscription_id = ${seeded.subscriptionId}::uuid`;

    return seeded;
  }
);

// Obtain every position through HTTP, including the last row's prev cursor.
const positionsOf = Effect.fn("DeadPagingTest.positions")(function* positionsOf(
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

    const relation = linksOf(page.headers.get("link")).has("next")
      ? "next"
      : "prev";

    const url = linkedUrl(page, relation);
    positions.push(
      url.searchParams.get(relation === "next" ? "after" : "before") ?? ""
    );

    if (relation === "next") {
      next = linkedPath(page, "next");
    }
  }

  return positions;
});

const proveAdjacentPages = Effect.fn("DeadPagingTest.adjacent")(
  function* proveAdjacentPages(
    get: GetPage,
    path: string,
    pages: readonly TestResponse[],
    interior: readonly string[]
  ) {
    // Every advertised destination is nonempty, and switching direction retains
    // both ends even after reaching the first/last bounded page backwards.
    for (const [index, page] of pages.entries()) {
      for (const [relation, step] of [
        ["prev", -1],
        ["next", 1],
      ] as const) {
        if (!linksOf(page.headers.get("link")).has(relation)) {
          continue;
        }

        const url = linkedUrl(page, relation);
        const controls = new Set(["after", "before"]);
        assert.deepStrictEqual(
          [...url.searchParams].filter(([name]) => !controls.has(name)),
          [...new URL(path, "http://std.test").searchParams]
        );
        const adjacent = yield* get(`${url.pathname}${url.search}`);
        assert.strictEqual(adjacent.status, 200, adjacent.text);
        assert.deepStrictEqual(idsOf(adjacent), [interior[index + step]]);

        if (index + step === 0) {
          assert.isFalse(linksOf(adjacent.headers.get("link")).has("prev"));
        }

        if (index + step === interior.length - 1) {
          assert.isFalse(linksOf(adjacent.headers.get("link")).has("next"));
        }

        const returned = yield* get(
          linkedPath(adjacent, step === 1 ? "prev" : "next")
        );

        assert.deepStrictEqual(idsOf(returned), idsOf(page));
      }
    }
  }
);

const proveRange = Effect.fn("DeadPagingTest.range")(function* proveRange(
  get: GetPage,
  path: string,
  expected: readonly string[]
) {
  const positions = yield* positionsOf(get, path, expected);
  const after = positions.at(0) ?? "";
  const before = positions.at(-1) ?? "";
  const bounded = `${path}&${new URLSearchParams({ after, before }).toString()}`;
  const interior = expected.slice(1, -1);
  const pages: TestResponse[] = [];
  let next = bounded;

  for (const [index, id] of interior.entries()) {
    const page = yield* get(next);
    assert.strictEqual(page.status, 200, page.text);
    assert.deepStrictEqual(idsOf(page), [id]);
    assert.strictEqual(page.headers.get("x-result-count"), "1");
    assert.strictEqual(
      page.headers.get("x-total-count"),
      String(expected.length)
    );
    const links = linksOf(page.headers.get("link"));
    assert.sameMembers(
      [...links.keys()],
      [
        "self",
        ...(index > 0 ? ["prev"] : []),
        ...(index < interior.length - 1 ? ["next"] : []),
      ]
    );
    pages.push(page);

    if (links.has("next")) {
      next = linkedPath(page, "next");
    }
  }

  yield* proveAdjacentPages(get, path, pages, interior);

  let backward = pages.at(-1);

  for (const id of interior.toReversed()) {
    assert.isDefined(backward);
    assert.deepStrictEqual(idsOf(backward ?? pages[0]), [id]);

    if (
      backward !== undefined &&
      linksOf(backward.headers.get("link")).has("prev")
    ) {
      backward = yield* get(linkedPath(backward, "prev"));
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
    assert.deepStrictEqual(
      [...linksOf(empty.headers.get("link")).keys()],
      ["self"]
    );
    assert.strictEqual(
      empty.headers.get("x-total-count"),
      String(expected.length)
    );
  }

  return { after, before, bounded };
});

describe("dead-delivery paging", () => {
  it("preserves the position-only envelope for unbounded int8 cursors", () => {
    assert.strictEqual(
      Buffer.from(
        encodeCursor([], { id: "10000000000000001", values: [] }),
        "base64url"
      ).toString("utf-8"),
      '{"i":"10000000000000001","k":[],"s":[]}'
    );
  });

  it.effect(
    "retains the issued upper bound after an accepted zero lower position",
    () =>
      Effect.gen(function* zeroLower() {
        const http = yield* TestHttpClient;
        const admin = { token: yield* http.signIn("ada", "ada-password") };
        const seeded = yield* seedDeadLetters(admin);
        const other = yield* seedDeadLetters(admin);
        const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId},${other.subscriptionId}&limit=1`;

        const ordered = yield* http.get(
          path.replace("limit=1", "limit=4"),
          admin
        );

        const expected = idsOf(ordered);
        assert.lengthOf(expected, 4);

        const positions = yield* positionsOf(
          (uri) => http.get(uri, admin),
          path,
          expected
        );

        const before = positions.at(-1) ?? "";

        const parsed = parseJson(
          Buffer.from(before, "base64url").toString("utf-8")
        );

        assert.isTrue(parsed.ok);

        if (!parsed.ok) {
          throw new Error("Expected an issued cursor");
        }

        const after = Buffer.from(
          JSON.stringify({ ...asObject(parsed.value), i: "0" })
        ).toString("base64url");

        let next = `${path}&${new URLSearchParams({ after, before }).toString()}`;
        const observed: string[] = [];

        for (const id of expected) {
          const page = yield* http.get(next, admin);
          assert.strictEqual(page.status, 200, page.text);
          assert.lengthOf(idsOf(page), 1, id);
          observed.push(...idsOf(page));

          if (!linksOf(page.headers.get("link")).has("next")) {
            break;
          }

          next = linkedPath(page, "next");
        }

        assert.deepStrictEqual(observed, expected.slice(0, -1));
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "retains exclusive bounds across three pages and direction changes with exact int8 identities",
    () =>
      Effect.gen(function* ranges() {
        const http = yield* TestHttpClient;
        const admin = { token: yield* http.signIn("ada", "ada-password") };
        const sql = yield* SqlClient.SqlClient;
        // Adjacent int8s beyond JS safe integers, spanning a decimal width change:
        // numeric sorting differs from text sorting and Number loses identity.
        yield* sql`SELECT setval(pg_get_serial_sequence('core.delivery', 'id'), '9999999999999998'::int8)`;
        const seeded = yield* fiveDeliveries(admin);

        const ascending = [
          "9999999999999999",
          "10000000000000000",
          "10000000000000001",
          "10000000000000002",
          "10000000000000003",
        ];

        const get = (path: string) => http.get(path, admin);

        for (const [sort, fields, expected] of [
          ["id", "attempts", ascending],
          ["-id", "none", ascending.toReversed()],
          ["attempts", "!lastError", ascending],
          ["-recordVersion", "recordVersion", ascending.toReversed()],
        ] as const) {
          const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&attempts.gte=0&attempts.gte=1&sort=${sort}&fields=${fields}&limit=1`;
          const { bounded } = yield* proveRange(get, path, expected);
          const uncounted = yield* get(`${bounded}&count=false`);
          assert.isNull(uncounted.headers.get("x-total-count"));
          assert.deepStrictEqual(idsOf(uncounted), [expected[1]]);
          const continuation = yield* get(linkedPath(uncounted, "next"));
          assert.isNull(continuation.headers.get("x-total-count"));
          assert.deepStrictEqual(idsOf(continuation), [expected[2]]);

          const cursor =
            linkedUrl(uncounted, "next").searchParams.get("after") ?? "";

          const decoded = parseJson(
            Buffer.from(cursor, "base64url").toString("utf-8")
          );

          assert.isTrue(decoded.ok);

          if (decoded.ok) {
            const envelope = asObject(decoded.value);
            assert.strictEqual(envelope.i, expected[1]);
            const range = asObject(envelope.range);
            assert.strictEqual(asObject(range.after).i, expected[0]);
            assert.strictEqual(asObject(range.before).i, expected.at(-1));

            for (const invalidRange of [
              {
                ...range,
                after: { ...asObject(range.after), i: "9223372036854775808" },
              },
              { ...range, before: { ...asObject(range.before), k: [] } },
            ]) {
              const invalid = yield* get(
                `${path}&after=${Buffer.from(JSON.stringify({ ...envelope, range: invalidRange })).toString("base64url")}`
              );

              assert.strictEqual(invalid.status, 400, invalid.text);
              assert.strictEqual(asObject(invalid.json).code, "InvalidCursor");
            }
          }
        }
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "omits empty adjacent links at filtered ends and counts matches independently of bounds",
    () =>
      Effect.gen(function* filteredEnds() {
        const http = yield* TestHttpClient;
        const admin = { token: yield* http.signIn("ada", "ada-password") };
        const seeded = yield* fiveDeliveries(admin);
        const get = (path: string) => http.get(path, admin);
        const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&sort=recordVersion&fields=none&limit=1`;
        const all = yield* get(path.replace("limit=1", "limit=5"));
        const positions = yield* positionsOf(get, path, idsOf(all));
        const after = positions.at(0) ?? "";
        const before = positions.at(-1) ?? "";

        for (const controls of [{ after, before }, { after }, { before }]) {
          const single = yield* get(
            `${path}&recordVersion=3&${new URLSearchParams(controls).toString()}`
          );

          assert.strictEqual(single.status, 200, single.text);
          assert.deepStrictEqual(idsOf(single), [idsOf(all)[2]]);
          assert.deepStrictEqual(
            [...linksOf(single.headers.get("link")).keys()],
            ["self"]
          );
          assert.strictEqual(single.headers.get("x-total-count"), "1");
        }

        const empty = yield* get(
          `${path}&recordVersion=5&${new URLSearchParams({ after, before }).toString()}`
        );

        assert.deepStrictEqual(idsOf(empty), []);
        assert.deepStrictEqual(
          [...linksOf(empty.headers.get("link")).keys()],
          ["self"]
        );
        assert.strictEqual(empty.headers.get("x-total-count"), "1");
        const offset = yield* get(`${path}&offset=0&count=false`);
        assert.strictEqual(offset.headers.get("x-total-count"), "5");
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );

  it.effect(
    "keeps masked identities out of range cursors, filters and counts and hides unauthorized requests",
    () =>
      Effect.gen(function* authorizedRanges() {
        const http = yield* TestHttpClient;
        const admin = { token: yield* http.signIn("ada", "ada-password") };
        const bob = { token: yield* http.signIn("bob", "bob-password") };
        const seeded = yield* fiveDeliveries(admin);
        const ruleId = randomUUID();
        yield* applyChangeSet({
          operations: [
            addAccessRule(
              ACME.asset,
              [BUILT_IN_ROLE_IDS.admin],
              {},
              {
                effect: "deny",
                id: ruleId,
                name: `dead_${ruleId.replaceAll("-", "")}`,
              }
            ).op,
          ],
        });
        const get = (path: string) => http.get(path, admin);
        const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&sort=recordVersion&fields=recordId,recordVersion&limit=1`;
        const all = yield* get(path.replace("limit=1", "limit=5"));
        const { bounded } = yield* proveRange(get, path, idsOf(all));
        const page = yield* get(bounded);
        const resource = asObject(asArray(page.json)[0]);
        assert.notProperty(resource, "recordId");
        assert.notProperty(resource, "recordVersion");
        assert.sameMembers(
          [...asArray(resource.withheld)],
          ["recordId", "recordVersion"]
        );
        const cursor = linkedUrl(page, "next").searchParams.get("after") ?? "";

        const decoded = parseJson(
          Buffer.from(cursor, "base64url").toString("utf-8")
        );

        assert.isTrue(decoded.ok);

        if (decoded.ok) {
          const envelope = asObject(decoded.value);
          assert.deepStrictEqual(envelope.k, [null]);

          for (const bound of Object.values(asObject(envelope.range))) {
            assert.deepStrictEqual(asObject(bound).k, [null]);
          }
        }

        const filtered = yield* get(`${bounded}&recordId=${seeded.recordId}`);
        assert.deepStrictEqual(idsOf(filtered), []);
        assert.strictEqual(filtered.headers.get("x-total-count"), "0");
        assert.deepStrictEqual(
          [...linksOf(filtered.headers.get("link")).keys()],
          ["self"]
        );

        const missing = yield* http.get(
          `${COLLECTION}/9223372036854775807`,
          bob
        );

        for (const uri of [
          bounded,
          linkedPath(page, "next"),
          `${COLLECTION}?after=bad`,
        ]) {
          const denied = yield* http.get(uri, bob);
          assert.strictEqual(denied.status, 404);
          assert.deepStrictEqual(denied.json, missing.json);
          assert.isNull(denied.headers.get("x-total-count"));
          assert.isNull(denied.headers.get("link"));
        }

        assert.strictEqual((yield* http.get(bounded)).status, 401);
      }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );
});
