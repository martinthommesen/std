/**
 * Helpers for the `/api/v2` suites (Contracts 10): paths in v2 names,
 * responses as JSON values, and the acme fixture's callers.
 */
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";

/** The acme tables' v2 collections. */
export const V2 = {
  asset: "/api/v2/acmeAsset",
  laptop: "/api/v2/acmeLaptop",
  monitor: "/api/v2/acmeMonitor",
  user: "/api/v2/coreUser",
} as const;

/**
 * A path with query parameters (repeats allowed).
 *
 * @param path - The path.
 * @param query - Name and value pairs.
 * @returns The path and query.
 */
export const withQuery = (
  path: string,
  query: readonly (readonly [string, string])[] = []
): string => {
  const search = new URLSearchParams(
    query.map(([key, value]) => [key, value])
  ).toString();

  return search === "" ? path : `${path}?${search}`;
};

/**
 * A JSON value as an object (empty when it is not one).
 *
 * @param value - Any JSON value.
 * @returns The object.
 */
export const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

/**
 * A JSON value as an array (empty when it is not one).
 *
 * @param value - Any JSON value.
 * @returns The array.
 */
export const asArray = (value: JsonValue | undefined): readonly JsonValue[] =>
  value !== undefined && isJsonArray(value) ? value : [];

/**
 * A JSON value as a string (empty when it is not one).
 *
 * @param value - Any JSON value.
 * @returns The string.
 */
export const textOf = (value: JsonValue | undefined): string =>
  value !== undefined && isJsonString(value) ? value : "";

/**
 * A JSON value as a number (0 when it is not one).
 *
 * @param value - Any JSON value.
 * @returns The number.
 */
export const numberOf = (value: JsonValue | undefined): number =>
  value !== undefined && isJsonNumber(value) ? value : 0;

/**
 * The IDs of a list response's resources, in order.
 *
 * @param response - A list response.
 * @returns The IDs.
 */
export const idsOf = (response: TestResponse): string[] =>
  asArray(response.json).map((item) => textOf(asObject(item).id));

/** Signed-in callers of the acme fixture. */
export interface V2Callers {
  readonly alice: TestRequestOptions;
  readonly bob: TestRequestOptions;
  readonly admin: TestRequestOptions;
}

/** Signs in Alice, Bob and Ada with bearer tokens. */
export const v2Callers = Effect.gen(function* signInCallers() {
  const http = yield* TestHttpClient;

  return {
    admin: { token: yield* http.signIn("ada", "ada-password") },
    alice: { token: yield* http.signIn("alice", "alice-password") },
    bob: { token: yield* http.signIn("bob", "bob-password") },
  } satisfies V2Callers;
});
