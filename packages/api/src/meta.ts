/**
 * `GET /api/v1/openapi.json`: the document generated from this definition.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import {
  BadRequestError,
  ReadConflictError,
  UnavailableError,
} from "./tmf-error.ts";

/** `GET /openapi.json`; no session needed. */
export class MetaGroup extends HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("openApi", "/openapi.json", {
    error: [BadRequestError, ReadConflictError, UnavailableError],
    success: Schema.Record(Schema.String, Schema.Json),
  })
) {}
