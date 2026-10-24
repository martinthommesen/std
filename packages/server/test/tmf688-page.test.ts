import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { pageAnswer } from "../src/http/tmf/page.ts";
import { linksOf } from "./paging.ts";

const origin = "http://std.test";
const path = `${TMF688_PREFIX}/topic`;
const test = it.effect;

const lists = [
  {
    attribute: "name",
    hidden: "headerQuery",
    kind: "Topic",
    selections: [
      { fields: "none", selected: false },
      { fields: "name", selected: true },
      { fields: "!headerQuery", selected: true },
      { fields: "name,!headerQuery", selected: true },
      { fields: "!headerQuery,name", selected: true },
    ],
  },
  {
    attribute: "query",
    hidden: "callback",
    kind: "Hub",
    selections: [
      { fields: "none", selected: false },
      { fields: "query", selected: true },
      { fields: "!query", selected: false },
      { fields: "query,!callback", selected: true },
      { fields: "!callback,query", selected: true },
    ],
  },
].flatMap(({ selections, ...list }) =>
  [false, true].flatMap((complete) =>
    selections.map((selection) => ({ ...list, ...selection, complete }))
  )
);

describe("TMF688 filtered offset navigation", () => {
  it.effect.each(lists)(
    "$kind links retain $fields and repeated filters with complete=$complete",
    ({ attribute, complete, fields, hidden, kind, selected }) =>
      Effect.gen(function* selectedLinks() {
        const listPath = kind === "Topic" ? path : `${path}/example/hub`;

        for (const scenario of [
          {
            first: [],
            ids: [],
            last: [],
            matched: 0,
            next: null,
            offset: 10,
            previous: null,
          },
          {
            first: ["999"],
            ids: [],
            last: ["999"],
            matched: 1,
            next: null,
            offset: 10,
            previous: ["999"],
          },
          {
            first: ["999"],
            ids: ["999"],
            last: ["999"],
            matched: 1,
            next: null,
            offset: 0,
            previous: null,
          },
          {
            first: ["997", "998"],
            ids: [],
            last: ["999"],
            matched: 3,
            next: null,
            offset: 10,
            previous: ["999"],
          },
          {
            first: ["997", "998"],
            ids: ["999"],
            last: ["999"],
            matched: 3,
            next: null,
            offset: 2,
            previous: ["997", "998"],
          },
          {
            first: ["997", "998"],
            ids: ["997", "998"],
            last: ["999"],
            matched: 3,
            next: ["999"],
            offset: 0,
            previous: null,
          },
        ]) {
          const resources = Array.from({ length: 1000 }, (_, index) => ({
            "@baseType": kind,
            "@schemaLocation": "https://example.test/resource.schema.json",
            "@type": kind,
            [hidden]: "https://example.test/listener",
            href: `${origin}${listPath}/${index}`,
            id: String(index),
            [attribute]: index >= 1000 - scenario.matched ? "yes" : "other",
          }));

          const get = Effect.fn("Tmf688PageTest.selectedGet")(function* get(
            url: URL
          ) {
            return HttpServerResponse.toWeb(
              yield* pageAnswer(
                resources,
                url.searchParams,
                [attribute, hidden],
                {
                  origin,
                  request: HttpServerRequest.fromWeb(new Request(url)),
                },
                complete
              )
            );
          });

          const params = new URLSearchParams([
            [attribute, "yes"],
            [attribute, "alternate"],
            [hidden, "https://example.test/listener"],
            ["fields", fields],
            ["count", "true"],
            ["limit", "2"],
            ["offset", String(scenario.offset)],
          ]);

          const response = yield* get(
            new URL(`${listPath}?${params.toString()}`, origin)
          );

          const links = linksOf(response.headers.get("link"));

          for (const [relation, expectedIds] of [
            ["self", scenario.ids],
            ["first", scenario.first],
            ["prev", scenario.previous],
            ["next", scenario.next],
            ["last", complete ? scenario.last : null],
          ] as const) {
            const link = links.get(relation);

            if (expectedIds === null) {
              assert.isUndefined(link);
              continue;
            }

            assert.isDefined(link);
            const url = new URL(link ?? "");
            assert.strictEqual(url.pathname, listPath);
            assert.deepStrictEqual(url.searchParams.getAll(attribute), [
              "yes",
              "alternate",
            ]);
            assert.strictEqual(
              url.searchParams.get(hidden),
              "https://example.test/listener"
            );
            assert.strictEqual(url.searchParams.get("fields"), fields);
            assert.strictEqual(url.searchParams.get("count"), "true");
            assert.strictEqual(url.searchParams.get("limit"), "2");

            const page = yield* get(url);
            assert.strictEqual(page.status, 200);
            assert.strictEqual(
              page.headers.get("x-result-count"),
              String(expectedIds.length)
            );
            assert.strictEqual(
              page.headers.get("x-total-count"),
              complete ? String(scenario.matched) : null
            );
            assert.strictEqual(
              linksOf(page.headers.get("link")).has("last"),
              complete
            );

            const body: unknown = yield* Effect.promise(
              async () => await page.json()
            );

            assert.deepStrictEqual(
              body,
              expectedIds.map((id) => {
                const identity = {
                  "@baseType": kind,
                  "@schemaLocation":
                    "https://example.test/resource.schema.json",
                  "@type": kind,
                  href: `${origin}${listPath}/${id}`,
                  id,
                };

                const expected =
                  kind === "Hub"
                    ? { ...identity, callback: "https://example.test/listener" }
                    : identity;

                return selected
                  ? { ...expected, [attribute]: "yes" }
                  : expected;
              })
            );
          }
        }
      })
  );

  test("incomplete enumeration uses known zero and small filtered subsets without claiming an exact total", () =>
    Effect.gen(function* incompleteEnumeration() {
      for (const scenario of [
        {
          ids: [],
          limit: 1,
          matched: 0,
          next: null,
          offset: 10,
          previous: null,
        },
        {
          ids: [],
          limit: 1,
          matched: 1,
          next: null,
          offset: 10,
          previous: ["0"],
        },
        {
          ids: ["0"],
          limit: 1,
          matched: 1,
          next: null,
          offset: 0,
          previous: null,
        },
        {
          ids: [],
          limit: 2,
          matched: 3,
          next: null,
          offset: 10,
          previous: ["2"],
        },
        {
          ids: ["2"],
          limit: 2,
          matched: 3,
          next: null,
          offset: 2,
          previous: ["0", "1"],
        },
        {
          ids: ["0", "1"],
          limit: 2,
          matched: 3,
          next: ["2"],
          offset: 0,
          previous: null,
        },
      ]) {
        // resourceRequest marks the existing 1,000-topic enumeration incomplete.
        const resources = Array.from({ length: 1000 }, (_, index) => ({
          "@type": "Topic",
          headerQuery: "private selection detail",
          href: `${origin}${path}/${index}`,
          id: String(index),
          name: index < scenario.matched ? "yes" : "other",
        }));

        const get = Effect.fn("Tmf688PageTest.get")(function* get(url: URL) {
          return HttpServerResponse.toWeb(
            yield* pageAnswer(
              resources,
              url.searchParams,
              ["name", "headerQuery"],
              {
                origin,
                request: HttpServerRequest.fromWeb(new Request(url)),
              },
              false
            )
          );
        });

        const params = new URLSearchParams({
          count: "true",
          fields: "name",
          limit: String(scenario.limit),
          name: "yes",
          offset: String(scenario.offset),
        });

        const response = yield* get(
          new URL(`${path}?${params.toString()}`, origin)
        );

        const links = linksOf(response.headers.get("link"));

        for (const [relation, expected] of [
          ["self", scenario.ids],
          ["prev", scenario.previous],
          ["next", scenario.next],
        ] as const) {
          const link = links.get(relation);

          if (expected === null) {
            assert.isUndefined(link);
            continue;
          }

          assert.isDefined(link);
          const url = new URL(link ?? "");
          assert.strictEqual(url.pathname, path);
          assert.strictEqual(url.searchParams.get("name"), "yes");
          assert.strictEqual(url.searchParams.get("fields"), "name");
          assert.strictEqual(url.searchParams.get("count"), "true");
          assert.strictEqual(
            url.searchParams.get("limit"),
            String(scenario.limit)
          );

          const page = yield* get(url);
          assert.strictEqual(page.status, 200);
          assert.strictEqual(
            page.headers.get("x-result-count"),
            String(expected.length)
          );
          assert.isNull(page.headers.get("x-total-count"));
          assert.isFalse(linksOf(page.headers.get("link")).has("last"));

          const body: unknown = yield* Effect.promise(
            async () => await page.json()
          );

          assert.deepStrictEqual(
            body,
            expected.map((id) => ({
              "@type": "Topic",
              href: `${origin}${path}/${id}`,
              id,
              name: "yes",
            }))
          );
        }
      }
    }));
});
