/** SQL paging and current-access noninterference through the history HTTP interface. */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Tracer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { AcmeFixture, acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import {
  apiCallers,
  asArray,
  asObject,
  textOf,
  API,
  withQuery,
} from "./api-support.ts";
import { ACME } from "./schema-support.ts";

// The security regression workload requested in F6: 2,000 versions, far beyond a one-entry page.
const LARGE_HISTORY = 2000;
const test = it.effect;
const UNKNOWN_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
const spans: Tracer.Span[] = [];

const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);

    return span;
  },
});

const testLayer = TestHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.merge(acmeTestLayer(), Layer.succeed(Tracer.Tracer, tracer))
  )
);

const linkOf = (
  response: TestResponse,
  relation: string
): string | undefined => {
  const entry = response.headers
    .get("link")
    ?.split(", ")
    .find((part) => part.endsWith(`; rel="${relation}"`));

  const href = entry?.slice(1, entry.indexOf(">"));

  if (href === undefined) {
    return undefined;
  }

  const url = new URL(href);

  return `${url.pathname}${url.search}`;
};

const seedHistory = Effect.fn("HistoryPaging.seed")(function* seedHistory(
  id: string,
  size: number,
  fieldId: string
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO core.change (id, class_id, version, created_at, created_by, updated_at, updated_by, operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
    SELECT uuidv7(), c.class_id, 1, c.occurred_at + n * interval '1 millisecond', c.actor_id, c.occurred_at + n * interval '1 millisecond', c.actor_id, c.operation_id, c.record_id, c.record_class_id, n, 'update', c.actor_id, c.cause, c.schema_revision, c.occurred_at + n * interval '1 millisecond', jsonb_build_object(${fieldId}::text, jsonb_build_object('before', 'value-' || (n - 1), 'after', 'value-' || n))
    FROM core.change c CROSS JOIN generate_series(2, ${size}) n WHERE c.record_id = ${id}::uuid AND c.record_version = 1`;
});

const createHistory = Effect.fn("HistoryPaging.create")(function* createHistory(
  size: number
) {
  const http = yield* TestHttpClient;
  const { alice } = yield* apiCallers;

  const created = yield* http.request("POST", API.asset, {
    ...alice,
    body: { name: "paging", status: "spare" },
  });

  assert.strictEqual(created.status, 201, created.text);
  const id = textOf(asObject(created.json).id);
  yield* seedHistory(id, size, ACME.name);

  return { caller: alice, path: `${API.asset}/${id}` };
});

const measure = Effect.fn("HistoryPaging.measure")(function* measure(
  path: string,
  caller: TestRequestOptions
) {
  const http = yield* TestHttpClient;
  const log = yield* StatementLog;
  yield* log.clear;
  spans.length = 0;
  const started = performance.now();
  const response = yield* http.get(path, caller);
  const elapsedMs = performance.now() - started;
  const statements = yield* log.texts;

  const decoded = spans.filter(
    (span) => span.name === "Records.historyEntry"
  ).length;

  const candidates = spans.flatMap((span) =>
    span.name === "History.pageOfRows"
      ? [span.attributes.get("history.candidate_rows")]
      : []
  );

  const definitions = spans.flatMap((span) =>
    span.name === "Records.history"
      ? [span.attributes.get("history.definition_entries")]
      : []
  );

  return { candidates, decoded, definitions, elapsedMs, response, statements };
});

const versions = (response: TestResponse) =>
  asArray(response.json).map((entry) => Number(asObject(entry).revision));

describe("api-history-paging", () => {
  test("bounds page, filtered, direct-ID and latest work on 2,000 versions", () =>
    Effect.gen(function* bounded() {
      const http = yield* TestHttpClient;
      const { path, caller } = yield* createHistory(LARGE_HISTORY);
      const initial = yield* http.get(`${path}/history?limit=1`, caller);
      const changeId = textOf(asObject(asArray(initial.json)[0]).id);
      const page = yield* measure(`${path}/history?limit=1`, caller);
      const single = yield* measure(`${path}/history/${changeId}`, caller);

      const filtered = yield* measure(
        `${path}/history?limit=1&kind=update`,
        caller
      );

      const latest = yield* measure(path, caller);

      for (const [name, result] of [
        ["page", page],
        ["single", single],
        ["filtered", filtered],
        ["latest", latest],
      ] as const) {
        yield* Effect.logInfo("history work receipt", {
          candidates: result.candidates,
          decoded: result.decoded,
          definitions: result.definitions,
          elapsedMs: result.elapsedMs,
          name,
          statements: result.statements.length,
        });
      }

      const receipt = JSON.stringify(
        [page, single, filtered, latest].map((result) => ({
          candidates: result.candidates,
          decoded: result.decoded,
          definitions: result.definitions,
          elapsedMs: result.elapsedMs,
          statements: result.statements.length,
        }))
      );

      for (const result of [page, single, filtered, latest]) {
        assert.strictEqual(result.response.status, 200, result.response.text);
        assert.strictEqual(result.decoded, 1, receipt);
        assert.lengthOf(
          result.statements.filter((text) =>
            text.includes("WITH selected AS MATERIALIZED")
          ),
          1
        );
        // One definition lookup at most; latest links need no historical descriptions.
        assert.isAtMost(
          result.statements.filter((text) =>
            text.includes('FROM "core"."definition_revision"')
          ).length,
          1
        );
      }

      assert.deepStrictEqual(page.candidates, [2]);
      assert.deepStrictEqual(filtered.candidates, [2]);
      assert.deepStrictEqual(single.candidates, [1]);
      assert.deepStrictEqual(latest.candidates, [1]);
      assert.deepStrictEqual(page.definitions, [1]);
      assert.deepStrictEqual(filtered.definitions, [1]);
      assert.deepStrictEqual(single.definitions, [1]);
      assert.deepStrictEqual(latest.definitions, [0]);
      assert.strictEqual(
        page.response.headers.get("x-total-count"),
        String(LARGE_HISTORY)
      );
      assert.strictEqual(
        filtered.response.headers.get("x-total-count"),
        String(LARGE_HISTORY - 1)
      );

      const entryStatement =
        single.statements.find((text) =>
          text.includes("WITH selected AS MATERIALIZED")
        ) ?? "";

      assert.match(entryStatement, /c\.id = \$\d+::uuid/u);
      assert.include(entryStatement, "ORDER BY c.record_version DESC LIMIT 1");
      assert.notInclude(entryStatement, "count(*)");
      assert.include(
        latest.response.headers.get("link") ?? "",
        `rel="latest-version"`
      );
      assert.strictEqual(
        linkOf(filtered.response, "latest-version"),
        linkOf(single.response, "latest-version")
      );

      const past = yield* http.get(
        `${path}/history?offset=2001&limit=1`,
        caller
      );

      assert.deepStrictEqual(versions(past), []);
      assert.strictEqual(
        past.headers.get("x-total-count"),
        String(LARGE_HISTORY)
      );

      const tail = yield* http.get(
        `${path}/history?offset=1999&limit=1`,
        caller
      );

      assert.deepStrictEqual(versions(tail), [LARGE_HISTORY]);

      const requests = Array.from({ length: 4 }, () =>
        http.get(`${path}/history?limit=1&count=false`, caller)
      );

      const concurrent = yield* Effect.all(requests, {
        concurrency: "unbounded",
      });

      for (const response of concurrent) {
        assert.strictEqual(response.status, 200, response.text);
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped, TestClock.withLive));

  layer(testLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "cursor traversal equals the complete small history exactly once in version order",
      () =>
        Effect.gen(function* equivalence() {
          const http = yield* TestHttpClient;
          const { path, caller } = yield* createHistory(11);

          const complete = yield* http.get(
            `${path}/history?offset=0&limit=100`,
            caller
          );

          assert.strictEqual(complete.status, 200, complete.text);

          for (const limit of [1, 2, 3, 5]) {
            const pages = [];

            let next: string | undefined =
              `${path}/history?count=false&limit=${limit}`;

            while (next !== undefined) {
              const response = yield* http.get(next, caller);
              assert.strictEqual(response.status, 200, response.text);
              assert.isNull(response.headers.get("x-total-count"));
              pages.push(...asArray(response.json));
              next = linkOf(response, "next");
              assert.isAtMost(
                pages.length,
                11,
                "a continuation must make progress"
              );
            }

            assert.deepStrictEqual(pages, asArray(complete.json));
            assert.lengthOf(
              new Set(pages.map((entry) => textOf(asObject(entry).id))),
              11
            );
          }

          const first = yield* http.get(
            `${path}/history?count=true&limit=3`,
            caller
          );

          const second = yield* http.get(linkOf(first, "next") ?? "", caller);
          const back = yield* http.get(linkOf(second, "prev") ?? "", caller);
          assert.deepStrictEqual(back.json, first.json);
          assert.strictEqual(second.headers.get("x-total-count"), "11");

          const rangeStart =
            new URL(
              `http://localhost${linkOf(first, "next") ?? ""}`
            ).searchParams.get("after") ?? "";

          const third = yield* http.get(linkOf(second, "next") ?? "", caller);

          const rangeEnd =
            new URL(
              `http://localhost${linkOf(third, "prev") ?? ""}`
            ).searchParams.get("before") ?? "";

          const range = yield* http.get(
            withQuery(`${path}/history`, [
              ["after", rangeStart],
              ["before", rangeEnd],
              ["limit", "10"],
            ]),
            caller
          );

          assert.deepStrictEqual(versions(range), [4, 5, 6]);

          const rangedFirst = yield* http.get(
            withQuery(`${path}/history`, [
              ["after", rangeStart],
              ["before", rangeEnd],
              ["limit", "2"],
            ]),
            caller
          );

          const rangedSecond = yield* http.get(
            linkOf(rangedFirst, "next") ?? "",
            caller
          );

          assert.deepStrictEqual(versions(rangedFirst), [4, 5]);
          assert.deepStrictEqual(versions(rangedSecond), [6]);
          assert.isUndefined(
            linkOf(rangedSecond, "next"),
            "forward continuation must retain the upper range bound"
          );

          const rangedBack = yield* http.get(
            linkOf(rangedSecond, "prev") ?? "",
            caller
          );

          assert.deepStrictEqual(
            versions(rangedBack),
            [4, 5],
            "before navigation selects the nearest preceding page"
          );

          const bad = yield* http.get(`${path}/history?after=broken`, caller);
          assert.strictEqual(bad.status, 400);

          const mixed = yield* http.get(
            withQuery(`${path}/history`, [
              ["after", rangeStart],
              ["offset", "0"],
            ]),
            caller
          );

          assert.strictEqual(mixed.status, 400);
        })
    );

    dbTest.effect(
      "SQL filters, fields and totals survive cursor navigation",
      () =>
        Effect.gen(function* filteredPages() {
          const http = yield* TestHttpClient;
          const { path, caller } = yield* createHistory(7);

          const first = yield* http.get(
            `${path}/history?count=true&limit=2&kind=update&revision.gte=3&fields=revision`,
            caller
          );

          assert.deepStrictEqual(versions(first), [3, 4]);
          assert.strictEqual(first.headers.get("x-total-count"), "5");
          const second = yield* http.get(linkOf(first, "next") ?? "", caller);
          assert.deepStrictEqual(versions(second), [5, 6]);
          assert.strictEqual(second.headers.get("x-total-count"), "5");
          assert.deepStrictEqual(
            Object.keys(asObject(asArray(second.json)[0])).toSorted(),
            ["@baseType", "@type", "href", "id", "revision"]
          );

          const offset = yield* http.get(
            `${path}/history?count=false&offset=1&limit=1`,
            caller
          );

          assert.strictEqual(
            offset.headers.get("x-total-count"),
            "7",
            "offset pages always carry the required total"
          );

          const empty = yield* http.get(
            `${path}/history?limit=1&kind=delete`,
            caller
          );

          assert.deepStrictEqual(empty.json, []);
          assert.strictEqual(empty.headers.get("x-total-count"), "0");
          assert.strictEqual(
            linkOf(empty, "latest-version"),
            linkOf(first, "latest-version")
          );
        })
    );

    dbTest.effect(
      "masked fields cannot affect filtered pages, links or totals",
      () =>
        Effect.gen(function* masks() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { bob } = yield* apiCallers;
          const path = `${API.asset}/${fixture.records.S}/history`;
          // S is lost: Bob can name purchased_on but cannot read it on this current row.
          yield* seedHistory(fixture.records.S, 5, ACME.purchasedOn);
          const query = `${path}?count=true&limit=1&field=${ACME.purchasedOn}`;
          const before = yield* http.get(query, bob);
          assert.strictEqual(before.status, 200, before.text);
          assert.deepStrictEqual(before.json, []);
          assert.strictEqual(before.headers.get("x-total-count"), "0");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE core.change SET fields = '{}'::jsonb WHERE record_id = ${fixture.records.S}::uuid`;
          const after = yield* http.get(query, bob);
          assert.strictEqual(after.text, before.text);
          assert.strictEqual(
            after.headers.get("link"),
            before.headers.get("link")
          );
          assert.strictEqual(
            after.headers.get("x-total-count"),
            before.headers.get("x-total-count")
          );
        })
    );

    dbTest.effect(
      "empty masked entries remain public saves and hidden records expose no paging information",
      () =>
        Effect.gen(function* hidden() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { bob } = yield* apiCallers;
          yield* seedHistory(fixture.records.L, 4, ACME.cost);
          const path = `${API.laptop}/${fixture.records.L}/history`;
          const page = yield* http.get(`${path}?limit=1&offset=1`, bob);
          assert.strictEqual(page.status, 200, page.text);
          assert.deepStrictEqual(asObject(asArray(page.json)[0]).changes, {});
          assert.deepStrictEqual(asObject(asArray(page.json)[0]).fields, {});
          assert.strictEqual(
            page.headers.get("x-total-count"),
            "4",
            "Contracts 3.7 exposes the save version even when every changed field is masked"
          );
          const wanted = textOf(asObject(asArray(page.json)[0]).id);
          const single = yield* http.get(`${path}/${wanted}`, bob);
          assert.strictEqual(single.status, 200, single.text);
          assert.isDefined(linkOf(single, "predecessor-version"));
          assert.isDefined(linkOf(single, "successor-version"));

          const missing = yield* http.get(
            `${API.laptop}/${UNKNOWN_ID}/history?limit=1&count=true`,
            bob
          );

          const invisible = yield* http.get(
            `${API.laptop}/${fixture.records.K}/history?limit=1&count=true`,
            bob
          );

          assert.strictEqual(invisible.status, 404);
          assert.strictEqual(invisible.text, missing.text);

          for (const response of [missing, invisible]) {
            assert.isNull(response.headers.get("x-result-count"));
            assert.isNull(response.headers.get("x-total-count"));
            assert.isNull(response.headers.get("link"));
          }
        })
    );
  });
});
