/**
 * Paging helpers for the `/api/v1` Contracts 3 suites: a list followed
 * through its `Link: rel="next"` header.
 */
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { idsOf } from "./api-support.ts";

/**
 * Reads the Link format emitted by STD, including hyphenated relations.
 * @param header - The response header, if present.
 * @returns Each relation's URI, in header order.
 */
export const linksOf = (header: string | null): Map<string, string> => {
  const links = new Map<string, string>();

  for (const part of header === null || header === ""
    ? []
    : header.split(", <")) {
    const uriEnd = part.indexOf(">");
    const relStart = part.indexOf('rel="', uriEnd) + 'rel="'.length;
    links.set(
      part.slice(relStart, part.indexOf('"', relStart)),
      part.slice(part.startsWith("<") ? 1 : 0, uriEnd)
    );
  }

  return links;
};

/**
 * The path and query of a response's rel="next" link.
 * @param link - The Link header, if any.
 * @returns The relative URL, or undefined on the last page.
 */
export const nextOf = (link: string | null): string | undefined => {
  const next = linksOf(link).get("next");

  if (next === undefined) {
    return undefined;
  }

  const url = new URL(next, "http://localhost");

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
