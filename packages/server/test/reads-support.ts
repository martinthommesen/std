/**
 * Helpers for the read-side tests: the acme fixture with the HTTP test
 * client, the API's paths for a qualified table name, and the parts of a
 * response the tests read (Contracts 10).
 */
import { apiTableNameOf } from "@std/definitions/names";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer } from "effect";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";

/**
 * The acme fixture plus the HTTP client over the same test database.
 * @returns The layer.
 */
export const readsTestLayer = () =>
  TestHttpClient.layer.pipe(Layer.provideMerge(acmeTestLayer()));

/**
 * A table's collection: its API name (`acme.asset` is `acmeAsset`).
 *
 * @param table - The qualified table name.
 * @returns The collection.
 */
export const collectionOf = (table: string): string => {
  const dot = table.indexOf(".");

  return apiTableNameOf(table.slice(0, dot), table.slice(dot + 1));
};

const withQuery = (
  path: string,
  query: Readonly<Record<string, string>>
): string => {
  const search = new URLSearchParams(query).toString();

  return search === "" ? path : `${path}?${search}`;
};

/**
 * The list path of a table with query parameters (`condition`, `fields`,
 * `sort`, `limit`, `after`, attribute filters, ...).
 *
 * @param table - The qualified table name.
 * @param query - Parameters.
 * @returns The path.
 */
export const listPath = (
  table: string,
  query: Readonly<Record<string, string>> = {}
): string => withQuery(`/api/v1/${collectionOf(table)}`, query);

/**
 * The single-resource path.
 *
 * @param table - The qualified table name.
 * @param id - The record ID.
 * @param query - Parameters.
 * @returns The path.
 */
export const recordPath = (
  table: string,
  id: string,
  query: Readonly<Record<string, string>> = {}
): string => withQuery(`/api/v1/${collectionOf(table)}/${id}`, query);

const objectOf = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

/** A list as the tests read it. */
export interface ListBody {
  /** The resources, in order. */
  readonly resources: readonly JsonObject[];
  /** `X-Total-Count`, when the answer carries it. */
  readonly total: number | undefined;
  /** The `after` cursor of the next page (`Link: rel="next"`), if any. */
  readonly next: string | undefined;
}

// The `after` cursor of a response's `rel="next"` link.
const nextCursorOf = (response: TestResponse): string | undefined => {
  const next = (response.headers.get("link") ?? "")
    .split(", ")
    .find((part) => part.endsWith('; rel="next"'));

  const link = next?.slice(1, next.indexOf(">"));

  return link === undefined
    ? undefined
    : (new URL(link).searchParams.get("after") ?? undefined);
};

/**
 * The list of a 200 response; dies otherwise.
 *
 * @param response - The response.
 * @returns The resources, the total and the next cursor.
 */
export const listOf = (response: TestResponse) =>
  response.status === 200 &&
  response.json !== undefined &&
  isJsonArray(response.json)
    ? Effect.succeed<ListBody>({
        next: nextCursorOf(response),
        resources: response.json.map((item) => objectOf(item)),
        total:
          response.headers.get("x-total-count") === null
            ? undefined
            : Number(response.headers.get("x-total-count")),
      })
    : Effect.die(
        new Error(`expected a list, got ${response.status} ${response.text}`)
      );

/**
 * The resource of a 200 or 201 single-resource response; dies otherwise.
 *
 * @param response - The response.
 * @returns The resource.
 */
export const resourceOf = (response: TestResponse) => {
  const answered = response.status === 200 || response.status === 201;

  return answered && response.json !== undefined && isJsonObject(response.json)
    ? Effect.succeed(response.json)
    : Effect.die(
        new Error(
          `expected a resource, got ${response.status} ${response.text}`
        )
      );
};

/**
 * The `code` of a TMF Error response; dies when the body has none.
 *
 * @param response - The response.
 * @returns The code.
 */
export const codeOf = (response: TestResponse) => {
  const { code } = objectOf(response.json);

  return code !== undefined && isJsonString(code)
    ? Effect.succeed(code)
    : Effect.die(
        new Error(`expected an error, got ${response.status} ${response.text}`)
      );
};

/**
 * The schema revision a response was served at (`STD-Schema-Revision`,
 * `<n>.<change_set_id>`); dies when it has none.
 *
 * @param response - The response.
 * @returns The revision number.
 */
export const revisionOf = (response: TestResponse) => {
  const header = response.headers.get("std-schema-revision");

  return header === null
    ? Effect.die(new Error(`no STD-Schema-Revision on ${response.status}`))
    : Effect.succeed(Number(header.split(".")[0]));
};

/**
 * Every page of a list, following `Link: rel="next"`.
 *
 * @param caller - The caller's request options (token or cookie).
 * @param table - The qualified table name.
 * @param query - Parameters (without `after`).
 * @returns The resources of every page in order, each page's text, and
 *   the first page's total.
 */
export const allPages = Effect.fn("ReadsSupport.allPages")(function* allPages(
  caller: TestRequestOptions,
  table: string,
  query: Readonly<Record<string, string>>
) {
  const http = yield* TestHttpClient;
  const resources: JsonObject[] = [];
  const texts: string[] = [];
  let after: string | undefined;
  let total: number | undefined;

  do {
    const response: TestResponse = yield* http.get(
      listPath(table, after === undefined ? query : { ...query, after }),
      caller
    );

    const page = yield* listOf(response);

    texts.push(response.text);
    resources.push(...page.resources);
    total ??= page.total;
    after = page.next;
  } while (after !== undefined);

  return { resources, texts, total };
});
