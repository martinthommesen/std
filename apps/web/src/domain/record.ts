/**
 * Records and history entries as the web app holds them (decision 0031).
 *
 * The API (Contracts 10) names attributes by their API names, writes
 * references as EntityRefs and leaves empty attributes out. The web app's
 * metadata still names fields, display fields, layouts and related lists by
 * definition name (Contracts 6.3), so the app keeps a record keyed the same
 * way: `values` by field name, every selected readable field present (`null`
 * when empty), a reference as its target's ID with its label in `labels`,
 * and `withheld` by field name. `wire.ts` converts at the API's edge, with
 * the metadata the request was built from, so nothing else in the app
 * changes when the API's names do.
 */
import { MetaFieldTypeSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";

/**
 * One record (Contracts 6.6): its concrete class (the resource's `@type`,
 * such as `HelpdeskIncident`), ID, version (the resource's `revision`), the
 * selected fields' values by field name, the labels of its references by
 * field name, and the selected fields an access rule withheld.
 */
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
 * One history entry (Contracts 4.2, 4.5, 10.4): `changes` and `fields`
 * keyed alike (by the attribute's API name, as the `ChangeEntry` has them),
 * the acting user's ID, and the record's version after the change.
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

/** One history entry. */
export type HistoryEntry = typeof HistoryEntrySchema.Type;
