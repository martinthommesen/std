/**
 * `GET /api/v2/openapi.json` (Contracts 10.1): the OpenAPI 3.1 document of
 * the generic API v2, derived from the shared `StdApiV2` definition in
 * `@std/api`. A table's own resource schema is at
 * `/api/v2/tableMetadata/{table}/schema.json` for the caller, because a
 * deployed server's tables are known only at run time (6.1); this document
 * describes the routes, the query parameters, the request and response
 * schemas and every error subtype, which TMF `Error`s name in
 * `@schemaLocation` (`#/components/schemas/<_tag>`, Contracts 10.6).
 */
import { StdApiV2 } from "@std/api/v2/api";
import type { JsonObject } from "@std/values/json-value";
import { Schema } from "effect";
import { OpenApi } from "effect/http-api";

/** The document. */
export const v2OpenApi: JsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Json)
)(OpenApi.fromApi(StdApiV2));
