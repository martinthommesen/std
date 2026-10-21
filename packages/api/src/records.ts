/**
 * Record JSON (Contracts 6.6) and the generic read endpoints.
 *
 * `values` are typed only at run time: a value's shape depends on its field
 * type (Contracts 6.5), so the envelope declares them as JSON. The server
 * writes record bodies itself with `stringifyJson`, so `json` field values
 * keep jsonb's key order; this schema is what clients decode.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { InvalidCursor } from "./errors/invalid-cursor.ts";
import { InvalidFilter } from "./errors/invalid-filter.ts";
import { InvalidRequest } from "./errors/invalid-request.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { NotFound } from "./errors/not-found.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";
import { UnknownField } from "./errors/unknown-field.ts";
import { UnknownTable } from "./errors/unknown-table.ts";

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

const readErrors = [
  UnknownTable,
  UnknownField,
  InvalidRequest,
  InvalidSchemaRevision,
  SchemaChanged,
] as const;

/** The generic record routes (Contracts 6.1): reads. Writes add to this group. */
export class RecordsGroup extends HttpApiGroup.make("records")
  .add(
    HttpApiEndpoint.get("list", "/tables/:table/records", {
      error: [...readErrors, InvalidFilter, InvalidCursor],
      params: { table: Schema.String },
      query: ListQuery,
      success: RecordListSchema,
    }),
    HttpApiEndpoint.get("get", "/tables/:table/records/:id", {
      error: [...readErrors, NotFound],
      params: { id: Schema.String, table: Schema.String },
      query: GetQuery,
      success: RecordResponseSchema,
    })
  )
  .middleware(Authentication) {}
