/**
 * The table metadata endpoints of `/api/v2` (Contracts 10.5).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { READ_ERRORS } from "./tmf-error.ts";

const table = { table: Schema.String } as const;

const JsonDocument = Schema.Record(Schema.String, Schema.Json);

/** The tables, one table's metadata, and its resource JSON Schema. */
export class TableMetadataGroup extends HttpApiGroup.make("tableMetadata").add(
  HttpApiEndpoint.get("list", "/tableMetadata", {
    error: READ_ERRORS,
    success: Schema.Array(JsonDocument),
  }),
  HttpApiEndpoint.get("get", "/tableMetadata/:table", {
    error: READ_ERRORS,
    params: table,
    success: JsonDocument,
  }),
  HttpApiEndpoint.get("schema", "/tableMetadata/:table/schema.json", {
    error: READ_ERRORS,
    params: table,
    success: JsonDocument,
  })
) {}
