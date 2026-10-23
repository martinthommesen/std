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

import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { signInAll } from "./authz-support.ts";
import { change } from "./schema-support.ts";

const REVISION_HEADER = "std-schema-revision";

/** The acme tables' v2 collections. */
export const API = {
  asset: "/api/v1/acmeAsset",
  laptop: "/api/v1/acmeLaptop",
  monitor: "/api/v1/acmeMonitor",
  user: "/api/v1/coreUser",
} as const;

/** An ID that belongs to no fixture record. */
export const UNKNOWN_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

/** The JSON Merge Patch media type. */
export const MERGE_PATCH = "application/merge-patch+json";

/** The JSON Patch media type. */
export const JSON_PATCH = "application/json-patch+json";

/**
 * Options for a JSON patch request, with an optional wire-format ETag.
 * @param caller - The caller.
 * @param contentType - The patch media type.
 * @param body - The patch document.
 * @param ifMatch - The expected ETag, already quoted.
 * @returns The request options.
 */
export const patchOptions = (
  caller: TestRequestOptions,
  contentType: string,
  body: JsonValue,
  ifMatch?: string
): TestRequestOptions => ({
  ...caller,
  headers:
    ifMatch === undefined
      ? { "content-type": contentType }
      : { "content-type": contentType, "if-match": ifMatch },
  rawBody: JSON.stringify(body),
});

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
 * A response's error code.
 * @param response - The response.
 * @returns Its code, when present.
 */
export const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

/**
 * The fields named by a schema-change response.
 * @param response - The response.
 * @returns The fields, in response order.
 */
export const changedFields = (response: TestResponse): string[] =>
  asArray(asObject(response.json).changes).map((entry) =>
    textOf(asObject(entry).field)
  );

/**
 * Headers for comparing responses independently of the request time.
 * @param response - The response.
 * @returns Every header except Date.
 */
export const withoutDate = (response: TestResponse): [string, string][] =>
  [...response.headers.entries()].filter(([name]) => name !== "date");

/**
 * The revisions of a history page.
 * @param response - The history response.
 * @returns Revisions in response order.
 */
export const revisionsOf = (response: TestResponse): number[] =>
  asArray(response.json).map((entry) => Number(asObject(entry).revision));

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
  const { tokens } = yield* signInAll;

  return {
    admin: { token: tokens.admin },
    alice: { token: tokens.alice },
    bob: { token: tokens.bob },
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
