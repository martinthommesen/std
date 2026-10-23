/**
 * Table metadata as the API serves it (Contracts 6.3, 10.5): the
 * browser-safe description of a table, whose names (fields, display field,
 * layouts, related lists, targets) are definition names, plus each field's
 * `apiName` and the table's collection (`id`), `classId`, `resourceType`
 * and `schemaRevision`. Every page holds metadata in this shape;
 * `wire.ts` uses the API names it carries.
 */
import type {
  TableMetadata,
  TableMetadataField,
  TableMetadataSummary,
} from "@std/api/table-metadata";

export {
  /** One table's metadata for the caller. */
  TableMetadata as MetaTableSchema,
  /** One field of a table's metadata, with its API name. */
  TableMetadataField as MetaFieldSchema,
  /** One table the caller can open, as the table list shows it. */
  TableMetadataSummary as MetaTableSummarySchema,
} from "@std/api/table-metadata";

/** One table's metadata for the caller. */
export type MetaTable = typeof TableMetadata.Type;

/** One field of a table's metadata. */
export type MetaField = typeof TableMetadataField.Type;

/** One table the caller can open. */
export type MetaTableSummary = typeof TableMetadataSummary.Type;
