/**
 * STD's API (Contracts 10): the TMF630 API as one `HttpApi` definition,
 * shared by the server, the web app and every client. Every route lives
 * under `/api/v1`. The server keeps its own routes; this definition is the
 * source of the OpenAPI 3.1 document served at `/api/v1/openapi.json`, of
 * the typed client (`client.ts`) and of the request and response schemas
 * the server and its tests check against. Every response carries
 * `STD-Schema-Revision: <n>.<change_set_id>` (Contracts 6.2).
 */
import { HttpApi, OpenApi } from "effect/http-api";

import { ChangeSetGroup } from "./change-sets.ts";
import { DeadLettersGroup } from "./dead-letters.ts";
import { MetaGroup } from "./meta.ts";
import { RecordsGroup } from "./records.ts";
import { SessionGroup } from "./session.ts";
import { TableMetadataGroup } from "./table-metadata.ts";

/** The response and request header carrying the schema revision. */
export const SCHEMA_REVISION_HEADER = "std-schema-revision";

/** The prefix of every route. */
export const API_PREFIX = "/api/v1";

/** Where the server serves the OpenAPI 3.1 document, without a session. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;

/** The description of the document. */
export const API_DESCRIPTION =
  "STD's API under TMF630 (Contracts 10). Tables are collections named by their API names; each table's resource schema is at /api/v1/tableMetadata/{table}/schema.json.";

/** The STD API. */
export class StdApi extends HttpApi.make("std")
  .add(SessionGroup)
  .add(TableMetadataGroup)
  .add(MetaGroup)
  .add(ChangeSetGroup)
  .add(DeadLettersGroup)
  .add(RecordsGroup)
  .annotate(OpenApi.Title, "STD API")
  .annotate(OpenApi.Version, "1")
  .annotate(OpenApi.Description, API_DESCRIPTION)
  .prefix("/api/v1") {}
