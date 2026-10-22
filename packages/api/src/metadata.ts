/**
 * Runtime metadata (Contracts 6.1, 6.3): which tables a signed-in caller
 * may open, what it may know about one table, and the table's OpenAPI
 * document for that caller.
 *
 * - `GET /meta/tables`: the tables the caller can open, by name, each with
 *   its label and whether the caller may create records there: exactly the
 *   tables whose metadata the caller gets, with the same values
 *   (`TableListSchema`, decision 0020).
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
 * All need a session and check a stated `STD-Schema-Revision` like an
 * endpoint naming no field (6.4): malformed is `400 InvalidSchemaRevision`,
 * a revision the database never had `409 SchemaChanged`; an older one is
 * served, since fresh metadata is what a stale client asks for.
 */
import {
  TableListSchema,
  TableMetadataSchema,
} from "@std/definitions/table-metadata";
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
    HttpApiEndpoint.get("tables", "/meta/tables", {
      error: [InvalidSchemaRevision, SchemaChanged],
      success: TableListSchema,
    }),
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
