/**
 * STD's generic API v2 (Contracts 10) as one `HttpApi` definition. The
 * server keeps its own routes; this definition is the source of the OpenAPI
 * 3.1 document served at `/api/v2/openapi.json` and of the request and
 * response schemas its tests check against.
 */
import { HttpApi, OpenApi } from "effect/http-api";

import { HubGroup } from "./hub.ts";
import { MetaGroup } from "./meta.ts";
import { RecordsGroup } from "./records.ts";
import { SessionGroup } from "./session.ts";
import { TableMetadataGroup } from "./table-metadata.ts";

/** The description of the document. */
export const V2_API_DESCRIPTION =
  "STD's generic API under TMF630 (Contracts 10). Tables are collections named by their v2 names; each table's resource schema is at /api/v2/tableMetadata/{table}/schema.json.";

/** The generic API v2. */
export class StdApiV2 extends HttpApi.make("std-v2")
  .add(HubGroup)
  .add(SessionGroup)
  .add(TableMetadataGroup)
  .add(MetaGroup)
  .add(RecordsGroup)
  .annotate(OpenApi.Title, "STD API")
  .annotate(OpenApi.Version, "2")
  .annotate(OpenApi.Description, V2_API_DESCRIPTION)
  .prefix("/api/v2") {}
