import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { parseJson } from "@std/values/json";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { pageAnswer } from "../src/http/tmf/page.ts";
import { asArray, asObject, textOf } from "./api-support.ts";
import { linksOf } from "./paging.ts";

const origin = "http://std.test";
const path = `${TMF688_PREFIX}/topic`;
const test = it.effect;

interface WindowPage {
  readonly ids: readonly string[];
  readonly links: ReadonlyMap<string, string>;
  readonly offset: number;
}

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

  it.effect.each(
    ["Topic", "Hub"].flatMap((kind) =>
      [false, true].flatMap((complete) =>
        [3, 7, 333, 999].map((limit) => ({ complete, kind, limit }))
      )
    )
  )(
    "$kind full window traverses both ways with limit=$limit and complete=$complete",
    ({ kind, complete, limit }) =>
      Effect.gen(function* fullWindow() {
        const listPath = kind === "Topic" ? path : `${path}/example/hub`;
        const attribute = kind === "Topic" ? "name" : "query";
        const hidden = kind === "Topic" ? "headerQuery" : "callback";

        // The existing bounded enumeration window is 1,000 (decision 0032 J10).
        const resources = Array.from({ length: 1000 }, (_, index) => ({
          "@type": kind,
          [attribute]: "yes",
          [hidden]: "https://example.test/listener",
          href: `${origin}${listPath}/${index}`,
          id: String(index),
        }));

        const expected = resources.map((resource) =>
          Object.fromEntries(
            Object.entries(resource).filter(([key]) => key !== "headerQuery")
          )
        );

        const get = Effect.fn("Tmf688PageTest.fullWindowGet")(function* get(
          href: string
        ) {
          const url = new URL(href, origin);
          assert.strictEqual(url.pathname, listPath);
          assert.deepStrictEqual(url.searchParams.getAll(attribute), [
            "yes",
            "alternate",
          ]);
          assert.strictEqual(
            url.searchParams.get(hidden),
            "https://example.test/listener"
          );
          assert.strictEqual(
            url.searchParams.get("fields"),
            `${attribute},!${hidden}`
          );
          assert.strictEqual(url.searchParams.get("count"), "true");

          const response = HttpServerResponse.toWeb(
            yield* pageAnswer(
              resources,
              url.searchParams,
              [attribute, hidden],
              { origin, request: HttpServerRequest.fromWeb(new Request(url)) },
              complete
            )
          );

          assert.strictEqual(response.status, 200);

          const parsed = parseJson(
            yield* Effect.promise(async () => await response.text())
          );

          assert.isTrue(parsed.ok);
          const body = asArray(parsed.ok ? parsed.value : undefined);
          const offset = Number(url.searchParams.get("offset"));
          const size = Number(url.searchParams.get("limit"));
          assert.isAbove(body.length, 0);
          assert.deepStrictEqual(body, expected.slice(offset, offset + size));
          assert.strictEqual(
            response.headers.get("x-result-count"),
            String(body.length)
          );
          assert.strictEqual(
            response.headers.get("x-total-count"),
            complete ? "1000" : null
          );
          const links = linksOf(response.headers.get("link"));
          assert.strictEqual(links.has("last"), complete);

          return {
            ids: body.map((item) => textOf(asObject(item).id)),
            links,
            offset,
          };
        });

        const followLinks = Effect.fn("Tmf688PageTest.followWindowLinks")(
          function* followLinks(page: WindowPage) {
            for (const [relation, href] of page.links) {
              const destination = yield* get(href);

              if (relation === "next") {
                assert.strictEqual(
                  destination.offset,
                  page.offset + page.ids.length
                );
              }

              if (relation === "prev") {
                assert.strictEqual(
                  destination.offset + destination.ids.length,
                  page.offset
                );
              }
            }
          }
        );

        const params = new URLSearchParams([
          [attribute, "yes"],
          [attribute, "alternate"],
          [hidden, "https://example.test/listener"],
          ["fields", `${attribute},!${hidden}`],
          ["count", "true"],
          ["offset", "0"],
          ["limit", String(limit)],
        ]);

        const initial = `${listPath}?${params.toString()}`;
        const forward: string[] = [];
        const seen = new Set<string>();
        let next: string | undefined = initial;
        let final = initial;

        while (next !== undefined) {
          assert.isFalse(seen.has(next), "navigation must make progress");
          seen.add(next);
          final = next;

          const page: WindowPage = yield* get(next);

          forward.push(...page.ids);

          yield* followLinks(page);

          next = page.links.get("next");
        }

        assert.deepStrictEqual(
          forward,
          resources.map(({ id }) => id)
        );

        // A shortened last window owns its effective limit. Its prev links
        // partition the preceding results without needing hidden page-size state.
        const first = yield* get(initial);

        for (const start of complete
          ? [final, first.links.get("last") ?? ""]
          : [final]) {
          const backward: (readonly string[])[] = [];
          const visited = new Set<string>();
          let previous: string | undefined = start;

          while (previous !== undefined) {
            assert.isFalse(
              visited.has(previous),
              "reverse navigation must make progress"
            );
            visited.add(previous);

            const page: WindowPage = yield* get(previous);

            backward.unshift(page.ids);

            yield* followLinks(page);

            previous = page.links.get("prev");
          }

          assert.deepStrictEqual(
            backward.flat(),
            resources.map(({ id }) => id)
          );
        }
      })
  );

  test("complete Hub totals beyond the offset window do not advertise unreachable pages", () =>
    Effect.gen(function* boundedHubTotal() {
      const resources = Array.from({ length: 1001 }, (_, index) => ({
        "@type": "Hub",
        callback: "https://example.test/listener",
        href: `${origin}${path}/example/hub/${index}`,
        id: String(index),
        query: "yes",
      }));

      const get = Effect.fn("Tmf688PageTest.boundedHubGet")(function* get(
        href: string
      ) {
        const url = new URL(href, origin);

        return HttpServerResponse.toWeb(
          yield* pageAnswer(
            resources,
            url.searchParams,
            ["callback", "query"],
            { origin, request: HttpServerRequest.fromWeb(new Request(url)) },
            true
          )
        );
      });

      const response = yield* get(`${path}/example/hub?offset=996&limit=3`);
      assert.strictEqual(response.headers.get("x-total-count"), "1001");
      const links = linksOf(response.headers.get("link"));

      for (const relation of ["next", "last"]) {
        const final = yield* get(links.get(relation) ?? "");
        assert.strictEqual(final.headers.get("x-total-count"), "1001");
        assert.strictEqual(final.headers.get("x-result-count"), "1");

        const parsed = parseJson(
          yield* Effect.promise(async () => await final.text())
        );

        assert.deepStrictEqual(
          asArray(parsed.ok ? parsed.value : undefined),
          resources.slice(999, 1000)
        );
        assert.isFalse(linksOf(final.headers.get("link")).has("next"));
      }
    }));

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
