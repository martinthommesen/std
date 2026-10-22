/**
 * Record JSON (Contracts 6.6) and the generic read endpoints.
 *
 * `values` are typed only at run time: a value's shape depends on its field
 * type (Contracts 6.5), so the envelope declares them as JSON. The server
 * writes record bodies itself with `stringifyJson`, so `json` field values
 * keep jsonb's key order; this schema is what clients decode.
 */
import { MetaFieldTypeSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { HookDepthExceeded } from "./errors/hook-depth-exceeded.ts";
import { InvalidCursor } from "./errors/invalid-cursor.ts";
import { InvalidFilter } from "./errors/invalid-filter.ts";
import { InvalidReference } from "./errors/invalid-reference.ts";
import { InvalidRequest } from "./errors/invalid-request.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { InvalidTransition } from "./errors/invalid-transition.ts";
import { NotAllowed } from "./errors/not-allowed.ts";
import { NotFound } from "./errors/not-found.ts";
import { RecordInSave } from "./errors/record-in-save.ts";
import { Referenced } from "./errors/referenced.ts";
import { RuleRefused } from "./errors/rule-refused.ts";
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
 * - `count`, `labels`: `true` or `false`;
 * - `allowedFor`: `<table>/<field>`, the reference field a picker fills
 *   (decision 0020): the field's allowed-records condition is ANDed to the
 *   filter, evaluated in the caller's view; the endpoint must be the
 *   field's target or one of its descendants.
 */
export const ListQuery = {
  allowedFor: Schema.optionalKey(Schema.String),
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

/**
 * How a history entry's field is read (Contracts 4.4, decision 0020): its
 * label, type (as metadata shows types) and choice labels as they were at
 * the entry's schema revision; `choices` is null for other field types.
 */
export const HistoryFieldSchema = Schema.Struct({
  choices: Schema.NullOr(
    Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String }))
  ),
  label: Schema.String,
  type: MetaFieldTypeSchema,
});

/** How a history entry's field is read. */
export type HistoryField = typeof HistoryFieldSchema.Type;

/**
 * One history entry (Contracts 4.2, 4.5); changes keyed by field name, and
 * `fields` describing exactly those fields, keyed the same way.
 */
export const HistoryEntrySchema = Schema.Struct({
  actor: Schema.String,
  cause: Schema.Json,
  changeId: Schema.String,
  changes: Schema.Record(Schema.String, Schema.Json),
  fields: Schema.Record(Schema.String, HistoryFieldSchema),
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
 * What record rules add to every write (Contracts 4.1, 4.10): a `refuse`
 * action's error, and the refusals of nested saves.
 */
const ruleErrors = [
  RuleRefused,
  InvalidTransition,
  RecordInSave,
  HookDepthExceeded,
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
  ...ruleErrors,
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
        // After rules of a delete save other records (4.10).
        ValidationFailed,
        InvalidReference,
        ...ruleErrors,
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
