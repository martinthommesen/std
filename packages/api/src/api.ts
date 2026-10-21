/**
 * STD's HTTP API (Contracts 6.1): one `HttpApi` definition shared by the
 * server, the web app and the SDK. Every route lives under `/api/v1`, and
 * every response carries `STD-Schema-Revision: <n>.<change_set_id>`
 * (Contracts 6.2).
 */
import { HttpApi } from "effect/http-api";

import { SignInGroup } from "./auth.ts";
import { MetaGroup } from "./meta.ts";
import { RecordsGroup } from "./records.ts";
import { RequestDecoding } from "./request-decoding.ts";
import { SchemaChangesGroup } from "./schema-changes.ts";
import { SessionGroup } from "./session.ts";

/** The response and request header carrying the schema revision. */
export const SCHEMA_REVISION_HEADER = "std-schema-revision";

/**
 * Where the server serves the OpenAPI 3.1 document generated from this
 * definition (`OpenApi.fromApi`), without a session: the `meta` group's
 * `openApi` endpoint.
 */
export const OPENAPI_PATH = "/api/v1/openapi.json";

/** The STD API. */
export class StdApi extends HttpApi.make("std")
  .add(SignInGroup)
  .add(SessionGroup)
  .add(RecordsGroup)
  .add(SchemaChangesGroup)
  .add(MetaGroup)
  .middleware(RequestDecoding)
  .prefix("/api/v1") {}
