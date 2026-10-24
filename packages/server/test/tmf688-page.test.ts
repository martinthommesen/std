import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { pageAnswer } from "../src/http/tmf/page.ts";
import { linksOf } from "./paging.ts";

const origin = "http://std.test";
const path = `${TMF688_PREFIX}/topic`;
const test = it.effect;

describe("TMF688 filtered offset navigation", () => {
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
