/**
 * Record JSON (Contracts 6.6) and the generic read endpoints.
 *
 * `values` are typed only at run time: a value's shape depends on its field
 * type (Contracts 6.5), so the envelope declares them as JSON. The server
 * writes record bodies itself with `stringifyJson`, so `json` field values
 * keep jsonb's key order; this schema is what clients decode.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { InvalidCursor } from "./errors/invalid-cursor.ts";
import { InvalidFilter } from "./errors/invalid-filter.ts";
import { InvalidReference } from "./errors/invalid-reference.ts";
import { InvalidRequest } from "./errors/invalid-request.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { NotAllowed } from "./errors/not-allowed.ts";
import { NotFound } from "./errors/not-found.ts";
import { Referenced } from "./errors/referenced.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";
import { UnknownField } from "./errors/unknown-field.ts";
import { UnknownTable } from "./errors/unknown-table.ts";
import { ValidationFailed } from "./errors/validation-failed.ts";
import { VersionConflict } from "./errors/version-conflict.ts";
import { VersionRequired } from "./errors/version-required.ts";
import { changeSetErrors } from "./schema-changes.ts";

/** One record (Contracts 6.6). */
export const RecordJsonSchema = Schema.Struct({
  class: Schema.String,
  id: Schema.String,
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  values: Schema.Record(Schema.String, Schema.Json),
  version: Schema.Int,
  withheld: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** One record. */
export type RecordJson = typeof RecordJsonSchema.Type;

/** `GET .../records/{id}`. */
export const RecordResponseSchema = Schema.Struct({
  record: RecordJsonSchema,
  schemaRevision: Schema.Int,
});

/** `GET .../records/{id}`. */
export type RecordResponse = typeof RecordResponseSchema.Type;

/** `GET .../records`: `count` only on request, `nextCursor` null on the last page. */
export const RecordListSchema = Schema.Struct({
  count: Schema.optionalKey(Schema.Int),
  nextCursor: Schema.NullOr(Schema.String),
  records: Schema.Array(RecordJsonSchema),
  schemaRevision: Schema.Int,
});

/** `GET .../records`. */
export type RecordList = typeof RecordListSchema.Type;

/**
 * The list query. Every parameter is text here and parsed by the server,
 * so a malformed value gets a typed `InvalidRequest`:
 *
 * - `filter`: the condition text syntax, names resolved against the
 *   caller's visible schema;
 * - `sort`: comma-separated names, `-` for descending (`-cost,name`);
 * - `fields`: comma-separated names and one-hop paths (`docked_to.name`);
 * - `cursor`: a `nextCursor` from the previous page;
 * - `limit`: 1 to 1000 (default 100);
 * - `count`, `labels`: `true` or `false`.
 */
export const ListQuery = {
  count: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.String),
  filter: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(Schema.String),
} as const;

/** The query of a single read: selection and labels. */
export const GetQuery = {
  fields: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.String),
} as const;

/**
 * A write body (Contracts 6.6, 6.7): field values by name. An absent key
 * and `null` differ; `id`, `class`, `version` and the audit fields are
 * refused with `ReadOnlyField`. The server parses the body text itself
 * with the json rules of Contracts 6.5.
 */
export const WriteBodySchema = Schema.Record(Schema.String, Schema.Json);

/**
 * The response of a create or update: the record projected with the
 * caller's read rights through the endpoint, or only `id` and `version`
 * when the caller can no longer see it (Contracts 3.9).
 */
export const SavedResponseSchema = Schema.Struct({
  record: Schema.Union([
    RecordJsonSchema,
    Schema.Struct({ id: Schema.String, version: Schema.Int }),
  ]),
  schemaRevision: Schema.Int,
});

/** The response of a create or update. */
export type SavedResponse = typeof SavedResponseSchema.Type;

/** The response of a delete: the version of its change entry. */
export const DeletedResponseSchema = Schema.Struct({
  id: Schema.String,
  schemaRevision: Schema.Int,
  version: Schema.Int,
});

/** `If-Match: "<version>"` (Contracts 6.7). */
export const IfMatchHeaders = {
  "if-match": Schema.optionalKey(Schema.String),
} as const;

/** One history entry (Contracts 4.2, 4.5); changes keyed by field name. */
export const HistoryEntrySchema = Schema.Struct({
  actor: Schema.String,
  cause: Schema.Json,
  changeId: Schema.String,
  changes: Schema.Record(Schema.String, Schema.Json),
  kind: Schema.Literals(["create", "update", "delete"]),
  occurredAt: Schema.String,
  operationId: Schema.String,
  schemaRevision: Schema.Int,
  version: Schema.Int,
});

/** `GET .../records/{id}/history`. */
export const HistoryResponseSchema = Schema.Struct({
  entries: Schema.Array(HistoryEntrySchema),
  schemaRevision: Schema.Int,
});

/** `GET .../records/{id}/history`. */
export type HistoryResponse = typeof HistoryResponseSchema.Type;

/**
 * History filters, comma-separated where several values are allowed:
 * `since`, `until` (RFC 3339), `actor` (user IDs), `kind`, `field` (field
 * IDs the caller can read).
 */
export const HistoryQuery = {
  actor: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
} as const;

/** The path of one record. */
const RECORD_PATH = "/tables/:table/records/:id";

const readErrors = [
  UnknownTable,
  UnknownField,
  InvalidRequest,
  InvalidSchemaRevision,
  SchemaChanged,
] as const;

/**
 * Write errors. Writes to definition tables become one-operation change
 * sets (Contracts 1.4), so they can also end in a change set's refusals.
 */
const writeErrors = [
  ...readErrors,
  ValidationFailed,
  InvalidReference,
  NotAllowed,
  NotFound,
  ...changeSetErrors,
] as const;

const versionErrors = [VersionRequired, VersionConflict] as const;

/** The generic record routes (Contracts 6.1): reads, writes and history. */
export class RecordsGroup extends HttpApiGroup.make("records")
  .add(
    HttpApiEndpoint.get("list", "/tables/:table/records", {
      error: [...readErrors, InvalidFilter, InvalidCursor],
      params: { table: Schema.String },
      query: ListQuery,
      success: RecordListSchema,
    }),
    HttpApiEndpoint.get("get", RECORD_PATH, {
      error: [...readErrors, NotFound],
      params: { id: Schema.String, table: Schema.String },
      query: GetQuery,
      success: RecordResponseSchema,
    }),
    HttpApiEndpoint.post("create", "/tables/:table/records", {
      error: writeErrors,
      params: { table: Schema.String },
      payload: WriteBodySchema,
      success: SavedResponseSchema.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.patch("update", RECORD_PATH, {
      error: [...writeErrors, ...versionErrors],
      headers: IfMatchHeaders,
      params: { id: Schema.String, table: Schema.String },
      payload: WriteBodySchema,
      success: SavedResponseSchema,
    }),
    HttpApiEndpoint.delete("remove", RECORD_PATH, {
      error: [
        ...readErrors,
        NotFound,
        NotAllowed,
        Referenced,
        ...versionErrors,
        ...changeSetErrors,
      ],
      headers: IfMatchHeaders,
      params: { id: Schema.String, table: Schema.String },
      success: DeletedResponseSchema,
    }),
    HttpApiEndpoint.get("history", "/tables/:table/records/:id/history", {
      error: [...readErrors, NotFound],
      params: { id: Schema.String, table: Schema.String },
      query: HistoryQuery,
      success: HistoryResponseSchema,
    })
  )
  .middleware(Authentication) {}
