/**
 * Paging helpers for the `/api/v2` Contracts 3 suites: a list followed
 * through its `Link: rel="next"` header.
 */
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { idsOf } from "./v2-support.ts";

const NEXT_SUFFIX = '>; rel="next"';

/**
 * The path and query of a response's `rel="next"` link.
 *
 * @param link - The `Link` header, if any.
 * @returns The relative URL, or undefined on the last page.
 */
export const nextOf = (link: string | null): string | undefined => {
  const entry = (link ?? "")
    .split(", ")
    .find((candidate) => candidate.endsWith(NEXT_SUFFIX));

  if (entry === undefined) {
    return undefined;
  }

  const url = new URL(
    entry.slice(entry.indexOf("<") + 1, -NEXT_SUFFIX.length),
    "http://localhost"
  );

  return `${url.pathname}${url.search}`;
};

/**
 * Every page of a v2 list, following `Link: rel="next"`.
 *
 * @param path - The first page's path and query.
 * @param caller - The signed-in caller.
 * @returns The IDs in order, each page's exact body text and counts, and
 *   the first page's `X-Total-Count`.
 */
export const allPagesV2 = Effect.fn("PagingV2.allPages")(function* allPagesV2(
  path: string,
  caller: TestRequestOptions
) {
  const http = yield* TestHttpClient;
  const ids: string[] = [];
  const texts: string[] = [];
  let total: string | null = null;
  let next: string | undefined = path;
  let first = true;

  while (next !== undefined) {
    const response = yield* http.get(next, caller);

    if (response.status !== 200) {
      return yield* Effect.die(
        new Error(`GET ${next} answered ${response.status}: ${response.text}`)
      );
    }

    if (first) {
      total = response.headers.get("x-total-count");
      first = false;
    }

    ids.push(...idsOf(response));
    texts.push(
      `${response.text}|${response.headers.get("x-total-count") ?? ""}|${response.headers.get("x-result-count") ?? ""}`
    );
    next = nextOf(response.headers.get("link"));
  }

  return { ids, texts, total };
});
