/**
 * Errors in `/api/v2` (Contracts 10.6): every error body is a TMF `Error`,
 *
 * ```json
 * { "@type": "<_tag>", "@baseType": "Error",
 *   "@schemaLocation": "/api/v2/openapi.json#/components/schemas/<_tag>",
 *   "code": "<_tag>", "reason": "<fixed text per _tag>",
 *   "message": "<fixed template>", "status": "<HTTP status>", ...details }
 * ```
 *
 * with the status codes of Contracts 3.8, except that a stale `If-Match` is
 * `412` (Martin, 2026-10-22; TMF630 v5.0.0 Part 1 §1.5.3 p.14), with the
 * current version in `ETag`. STD's details stay as extension attributes of
 * the subtype (`fieldErrors`, `currentVersion`, `requestRevision`,
 * `currentRevision`, `changes`, `problems`, `issues`, ...), with field names
 * in their API spelling. `message` is a fixed text per tag (for
 * `InvalidRequest`, per check), never a value or Postgres text, so the
 * identical-response rules of Contracts 3.4 and 3.8 hold byte for byte.
 */
import { LOCK_TIMEOUT_RETRY_AFTER_SECONDS } from "@std/api/schema-changes";
import { apiAttributeNameOf } from "@std/definitions/names";
import { stringifyJson } from "@std/values/json";
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  isJsonValue,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Predicate } from "effect";
import { HttpServerResponse } from "effect/http";

/**
 * The status of a stale If-Match in v2 (VersionConflict): 412 Precondition
 * Failed (Martin, 2026-10-22, M2). /api/v1 keeps 409.
 */
export const STALE_VERSION_STATUS = 412;

/** HTTP status and fixed reason of each error tag (Contracts 3.8, 10.6). */
const ERRORS = {
  DefinitionInvalid: [422, "The definitions are invalid; nothing was applied"],
  DefinitionProtected: [403, "The definition is protected"],
  DependencyConflict: [409, "Other definitions depend on this one"],
  ExistingDataViolates: [409, "Existing records violate the change"],
  FieldsConflict: [409, "fields includes and excludes the same attribute"],
  HookDepthExceeded: [422, "Hooks and record rules nest too deeply"],
  InvalidCredentials: [401, "The login or password is wrong"],
  InvalidCursor: [400, "The cursor was not issued for this sort"],
  InvalidFilter: [400, "The filter does not parse or check"],
  InvalidReference: [422, "A referenced record does not exist"],
  InvalidRequest: [400, "A request parameter is malformed"],
  InvalidSchemaRevision: [400, "The STD-Schema-Revision header is malformed"],
  InvalidTransition: [422, "The state change is not allowed"],
  MethodNotAllowed: [405, "The method is not allowed on this resource"],
  NotAllowed: [403, "The operation is not allowed"],
  NotFound: [404, "The resource does not exist"],
  NotImplemented: [501, "The request uses a feature STD does not implement"],
  PatchTestFailed: [409, "The patch does not apply to the current version"],
  PermissionRequired: [403, "A permission is required"],
  PurgeRefused: [409, "The purge is refused"],
  RecordInSave: [422, "The record is already being saved in this transaction"],
  Referenced: [409, "Other records refer to this record"],
  RuleRefused: [422, "A record rule refused the save"],
  SchemaBusy: [503, "Another schema change is running"],
  SchemaChanged: [409, "The schema changed since the request was built"],
  SchemaLockTimeout: [503, "The schema change could not get its locks"],
  SchemaNeedsAttention: [409, "A schema change needs attention"],
  Unauthenticated: [401, "No valid session"],
  UnknownField: [400, "No such field"],
  UnknownTable: [404, "No such table"],
  UnsupportedMediaType: [415, "The body's media type is not supported"],
  UseRetireOrPurge: [409, "Retire or purge the definition instead"],
  ValidationFailed: [422, "Field values are invalid"],
  VersionConflict: [
    STALE_VERSION_STATUS,
    "The record changed since the stated version",
  ],
  VersionRequired: [428, "If-Match with the record's version is required"],
} as const satisfies Readonly<Record<string, readonly [number, string]>>;

const ERROR_TABLE: ReadonlyMap<string, readonly [number, string]> = new Map(
  Object.entries(ERRORS)
);

/** The tags `/api/v2` answers with a TMF `Error`. */
export const TMF_ERROR_TAGS: readonly string[] = [...ERROR_TABLE.keys()];

/** Members of an error that are never details. */
const NOT_DETAILS: ReadonlySet<string> = new Set([
  "_tag",
  "message",
  "stack",
  "cause",
  "name",
]);

/** A tagged API error. */
export interface TaggedFailure {
  readonly _tag: string;
}

/**
 * Whether a failure has a TMF `Error` form in v2.
 *
 * @param failure - Any failure.
 * @returns True for every API error tag of Contracts 3.8 and 10.
 */
export const isTmfFailure = (failure: unknown): failure is TaggedFailure =>
  Predicate.hasProperty(failure, "_tag") &&
  Predicate.isString(failure._tag) &&
  ERROR_TABLE.has(failure._tag);

// A field name in a detail, in its API spelling.
const apiField = (name: JsonValue | undefined): JsonValue =>
  name !== undefined && isJsonString(name) ? apiAttributeNameOf(name) : null;

const withApiField = (value: JsonValue): JsonValue =>
  isJsonObject(value) && value.field !== undefined
    ? { ...value, field: apiField(value.field) }
    : value;

const listWithApiFields = (value: JsonValue | undefined): JsonValue =>
  value !== undefined && isJsonArray(value) ? value.map(withApiField) : null;

// STD's details as v2 shows them: `errors` of `ValidationFailed` become
// `fieldErrors`; field names take their API spelling (`UnknownField`
// repeats the request's own name).
const detailsOf = (tag: string, details: JsonObject): JsonObject => {
  switch (tag) {
    case "ValidationFailed": {
      return { fieldErrors: listWithApiFields(details.errors) };
    }

    case "InvalidReference": {
      return { field: apiField(details.field) };
    }

    case "SchemaChanged": {
      return { ...details, changes: listWithApiFields(details.changes) };
    }

    default: {
      return details;
    }
  }
};

const ownDetails = (failure: TaggedFailure): JsonObject =>
  Object.fromEntries(
    Object.entries(failure).filter(
      (entry): entry is [string, JsonValue] =>
        !NOT_DETAILS.has(entry[0]) && isJsonValue(entry[1])
    )
  );

/**
 * Tags whose message is a fixed text of its own: per check
 * (`InvalidRequest`), or as a record rule's author wrote it (`RuleRefused`,
 * `InvalidTransition`, Contracts 4.10).
 */
const OWN_MESSAGE: ReadonlySet<string> = new Set([
  "InvalidRequest",
  "InvalidTransition",
  "RuleRefused",
]);

// Those tags show their own message; every other tag's message is its
// reason.
const messageOf = (failure: TaggedFailure, reason: string): string =>
  OWN_MESSAGE.has(failure._tag) &&
  Predicate.hasProperty(failure, "message") &&
  Predicate.isString(failure.message)
    ? failure.message
    : reason;

/** An error as v2 answers it. */
export interface TmfError {
  readonly status: number;
  readonly body: JsonObject;
}

/**
 * The TMF `Error` body and status of an API error.
 *
 * @param failure - The error.
 * @returns The status and the body.
 */
export const tmfErrorOf = (failure: TaggedFailure): TmfError => {
  const tag = failure._tag;
  const [status, reason] = ERROR_TABLE.get(tag) ?? [500, "Internal error"];

  const body: JsonObject = {
    "@baseType": "Error",
    "@schemaLocation": `/api/v2/openapi.json#/components/schemas/${tag}`,
    "@type": tag,
    code: tag,
    message: messageOf(failure, reason),
    reason,
    status: String(status),
    ...detailsOf(tag, ownDetails(failure)),
  };

  return { body, status };
};

// Headers an error carries: `Retry-After` (503s), `Allow` (405),
// `Accept-Patch` (415), and the current `ETag` of a stale `If-Match`.
const headersOf = (tag: string, body: JsonObject): Map<string, string> => {
  const headers = new Map<string, string>();
  const { accepted, allow, currentVersion, retryAfterSeconds } = body;

  if (retryAfterSeconds !== undefined && isJsonNumber(retryAfterSeconds)) {
    headers.set("retry-after", String(retryAfterSeconds));
  }

  if (tag === "SchemaLockTimeout") {
    headers.set("retry-after", String(LOCK_TIMEOUT_RETRY_AFTER_SECONDS));
  }

  if (allow !== undefined && isJsonString(allow)) {
    headers.set("allow", allow);
  }

  if (accepted !== undefined && isJsonArray(accepted)) {
    headers.set("accept-patch", accepted.map(String).join(", "));
  }

  if (currentVersion !== undefined && isJsonNumber(currentVersion)) {
    headers.set("etag", `"${currentVersion}"`);
  }

  return headers;
};

/**
 * The response for an API error: the TMF `Error` body and its headers.
 *
 * @param failure - The error.
 * @returns The response.
 */
export const tmfErrorResponse = (
  failure: TaggedFailure
): HttpServerResponse.HttpServerResponse => {
  const { body, status } = tmfErrorOf(failure);

  return HttpServerResponse.text(stringifyJson(body), {
    contentType: "application/json",
    headers: Object.fromEntries(headersOf(failure._tag, body)),
    status,
  });
};
