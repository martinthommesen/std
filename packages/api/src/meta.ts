/**
 * The API's own description (Contracts 6.1): `GET /openapi.json`, the
 * OpenAPI 3.1 document generated from this definition, served without a
 * session. Like every endpoint it checks a stated `STD-Schema-Revision`
 * (6.4): malformed is `400 InvalidSchemaRevision`, a revision the database
 * never had is `409 SchemaChanged` with no changes (it names no field).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";

/** An OpenAPI document: a JSON object. */
export const OpenApiDocumentSchema = Schema.Record(Schema.String, Schema.Json);

/** `GET /openapi.json`; no session needed. */
export class MetaGroup extends HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("openApi", "/openapi.json", {
    error: [InvalidSchemaRevision, SchemaChanged],
    success: OpenApiDocumentSchema,
  })
) {}
