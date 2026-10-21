/**
 * Schemas carried by API errors: filter issues and schema changes
 * (Contracts 6.4).
 */
import { Schema } from "effect";

/** One problem with a filter; messages never contain literal values. */
export const FilterIssueSchema = Schema.Struct({
  message: Schema.String,
  reason: Schema.String,
  span: Schema.optionalKey(
    Schema.Struct({ end: Schema.Int, start: Schema.Int })
  ),
});

/** One problem with a filter. */
export type FilterIssue = typeof FilterIssueSchema.Type;

/** The kinds of schema change a stale request can hit (Contracts 6.4). */
export const SchemaChangeKindSchema = Schema.Literals([
  "fieldAdded",
  "fieldRenamed",
  "fieldRetired",
  "fieldPurged",
  "typeChanged",
  "settingsChanged",
  "choicesChanged",
  "requiredChanged",
  "readOnlyChanged",
  "tableRetired",
  "unknown",
]);

/** A schema change kind. */
export type SchemaChangeKind = typeof SchemaChangeKindSchema.Type;

/** One relevant change between the request's revision and the current one. */
export const SchemaChangeSchema = Schema.Struct({
  field: Schema.NullOr(Schema.String),
  fieldId: Schema.NullOr(Schema.String),
  kind: SchemaChangeKindSchema,
  revision: Schema.NullOr(Schema.Int),
  table: Schema.String,
});

/** One relevant change. */
export type SchemaChange = typeof SchemaChangeSchema.Type;
