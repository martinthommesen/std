/**
 * `GET /api/v1/openapi.json` (Contracts 10.1): the OpenAPI 3.1 document of
 * STD's API, derived from the shared `StdApi` definition in
 * `@std/api`. A table's own resource schema is at
 * `/api/v1/tableMetadata/{table}/schema.json` for the caller, because a
 * deployed server's tables are known only at run time (6.1); this document
 * describes the routes, the query parameters, the request and response
 * schemas and every error subtype, which TMF `Error`s name in
 * `@schemaLocation` (`#/components/schemas/<_tag>`, Contracts 10.6).
 */
import { StdApi } from "@std/api/api";
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Schema } from "effect";
import { OpenApi } from "effect/http-api";

/** The document. */
export const apiOpenApi: JsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json)
)(OpenApi.fromApi(StdApi));

/**
 * The document as the route answers it, written once: the document never
 * changes while the server runs.
 */
export const apiOpenApiText = stringifyJson(apiOpenApi);
