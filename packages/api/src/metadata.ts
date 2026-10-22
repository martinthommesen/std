/**
 * Runtime metadata (Contracts 6.1, 6.3): what a signed-in caller may know
 * about one table, and the table's OpenAPI document for that caller.
 *
 * - `GET /meta/tables/{table}`: the browser-safe description of the table
 *   (`@std/definitions/table-metadata`), from which the web app builds its
 *   forms, lists and `recordSchema`. A table the caller has no allow on is
 *   `UnknownTable`, identical to a missing one.
 * - `GET /meta/tables/{table}/openapi.json`: an OpenAPI 3.1 document of the
 *   table's generic record routes, with the record values described from
 *   the same metadata. It states the schema revision it describes
 *   (`info.version` is `<revision>.<change_set_id>`, and
 *   `x-std-schema-revision` the number).
 *
 * Both need a session and check a stated `STD-Schema-Revision` like an
 * endpoint naming no field (6.4): malformed is `400 InvalidSchemaRevision`,
 * a revision the database never had `409 SchemaChanged`; an older one is
 * served, since fresh metadata is what a stale client asks for.
 */
import { TableMetadataSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";
import { UnknownTable } from "./errors/unknown-table.ts";
import { OpenApiDocumentSchema } from "./meta.ts";

const errors = [UnknownTable, InvalidSchemaRevision, SchemaChanged] as const;

/** The metadata routes; a session is needed. */
export class MetadataGroup extends HttpApiGroup.make("metadata")
  .add(
    HttpApiEndpoint.get("table", "/meta/tables/:table", {
      error: errors,
      params: { table: Schema.String },
      success: TableMetadataSchema,
    }),
    HttpApiEndpoint.get("tableOpenApi", "/meta/tables/:table/openapi.json", {
      error: errors,
      params: { table: Schema.String },
      success: OpenApiDocumentSchema,
    })
  )
  .middleware(Authentication) {}
