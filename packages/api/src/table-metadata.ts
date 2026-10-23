/**
 * The table metadata endpoints of `/api/v1` (Contracts 10.5): the tables
 * the caller can open, one table's metadata for the caller (6.3, in the
 * shape of `@std/definitions/table-metadata` with the API names added), and
 * the table's resource JSON Schema and OpenAPI document.
 */
import {
  MetaFieldSchema,
  MetaTableSchema,
} from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { READ_ERRORS } from "./tmf-error.ts";

const table = { table: Schema.String } as const;

const JsonDocument = Schema.Record(Schema.String, Schema.Json);

/** One table the caller can open, as the table list shows it. */
export const TableMetadataSummary = Schema.Struct({
  "@type": Schema.Literal("TableMetadata"),
  /** Whether the caller may create records of exactly this table. */
  creatable: Schema.Boolean,
  /**
   * Whether the table holds definitions: its writes are change sets and a
   * `PATCH` takes only a merge patch (Contracts 1.4, 10.5). Optional, so
   * a body without it still decodes (decision 0017); the server always
   * sends it.
   */
  definitionTable: Schema.optionalKey(Schema.Boolean),
  href: Schema.String,
  /** The collection: the table's API name (`acmeAsset`). */
  id: Schema.String,
  label: Schema.String,
  /** The qualified definition name (`acme.asset`). */
  name: Schema.String,
  /** The `@type` of its resources (`AcmeAsset`). */
  resourceType: Schema.String,
}).annotate({ identifier: "TableMetadataSummary" });

/** One field of a table's metadata, with its API attribute name. */
export const TableMetadataField = Schema.Struct({
  ...MetaFieldSchema.fields,
  /** The attribute name in resources, filters and bodies (`dueDate`). */
  apiName: Schema.String,
}).annotate({ identifier: "TableMetadataField" });

/**
 * One table's metadata for the caller: the browser-safe description of
 * Contracts 6.3 (names are definition names: `name`, `displayField`,
 * layouts and related lists), with the API names a client needs.
 */
export const TableMetadata = Schema.Struct({
  ...MetaTableSchema.fields,
  "@type": Schema.Literal("TableMetadata"),
  /** The table's definition ID. */
  classId: Schema.String,
  /**
   * Whether the table holds definitions: its writes are change sets and a
   * `PATCH` takes only a merge patch (Contracts 1.4, 10.5). Optional, so
   * a body without it still decodes (decision 0017); the server always
   * sends it.
   */
  definitionTable: Schema.optionalKey(Schema.Boolean),
  fields: Schema.Array(TableMetadataField),
  href: Schema.String,
  /** The collection: the table's API name. */
  id: Schema.String,
  /** The `@type` of its resources. */
  resourceType: Schema.String,
  /** The schema revision the metadata describes. */
  schemaRevision: Schema.Int,
}).annotate({ identifier: "TableMetadata" });

/** The tables, one table's metadata, and its resource JSON Schema. */
export class TableMetadataGroup extends HttpApiGroup.make("tableMetadata").add(
  HttpApiEndpoint.get("list", "/tableMetadata", {
    error: READ_ERRORS,
    success: Schema.Array(TableMetadataSummary),
  }),
  HttpApiEndpoint.get("get", "/tableMetadata/:table", {
    error: READ_ERRORS,
    params: table,
    success: TableMetadata,
  }),
  HttpApiEndpoint.get("schema", "/tableMetadata/:table/schema.json", {
    error: READ_ERRORS,
    params: table,
    success: JsonDocument,
  }),
  HttpApiEndpoint.get("openApi", "/tableMetadata/:table/openapi.json", {
    error: READ_ERRORS,
    params: table,
    success: JsonDocument,
  })
) {}
