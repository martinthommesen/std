/**
 * Helpers for the `/api/v1` suites (Contracts 10): paths in v2 names,
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
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { change } from "./schema-support.ts";

const REVISION_HEADER = "std-schema-revision";

/** The acme tables' v2 collections. */
export const API = {
  asset: "/api/v1/acmeAsset",
  laptop: "/api/v1/acmeLaptop",
  monitor: "/api/v1/acmeMonitor",
  user: "/api/v1/coreUser",
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
export interface ApiCallers {
  readonly alice: TestRequestOptions;
  readonly bob: TestRequestOptions;
  readonly admin: TestRequestOptions;
}

/** Signs in Alice, Bob and Ada with bearer tokens. */
export const apiCallers = Effect.gen(function* signInCallers() {
  const http = yield* TestHttpClient;

  return {
    admin: { token: yield* http.signIn("ada", "ada-password") },
    alice: { token: yield* http.signIn("alice", "alice-password") },
    bob: { token: yield* http.signIn("bob", "bob-password") },
  } satisfies ApiCallers;
});

/**
 * The current revision of the catalog, as a request header value.
 *
 * @returns The header value.
 */
export const statedRevision = Effect.gen(function* stated() {
  const catalog = yield* Catalog;

  return revisionHeaderValue(yield* catalog.refresh);
});

/**
 * The current version of a definition.
 *
 * @param id - The field.
 * @returns Its version.
 */
export const versionOf = (id: string) =>
  Effect.gen(function* version() {
    const catalog = yield* Catalog;
    const built = yield* catalog.refresh;

    return built.field(id)?.version ?? 1;
  });

/**
 * Renames a field by change set.
 *
 * @param id - The field.
 * @param name - The new definition name.
 * @returns The renaming effect.
 */
export const rename = (id: string, name: string) =>
  Effect.gen(function* renameField() {
    yield* change([{ id, name, op: "rename", version: yield* versionOf(id) }]);
  }).pipe(Effect.orDie);

/**
 * A caller's request options stating an older schema revision.
 *
 * @param revision - The stated revision header value.
 * @param caller - The caller.
 * @returns The options.
 */
export const stale = (
  revision: string,
  caller: TestRequestOptions
): TestRequestOptions => ({
  ...caller,
  headers: { [REVISION_HEADER]: revision },
});
