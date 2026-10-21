/**
 * STD's HTTP API (Contracts 6.1): one `HttpApi` definition shared by the
 * server, the web app and the SDK. Every route lives under `/api/v1`, and
 * every response carries `STD-Schema-Revision: <n>.<change_set_id>`
 * (Contracts 6.2).
 */
import { HttpApi } from "effect/http-api";

import { SignInGroup } from "./auth.ts";
import { RecordsGroup } from "./records.ts";
import { SessionGroup } from "./session.ts";

/** The response and request header carrying the schema revision. */
export const SCHEMA_REVISION_HEADER = "std-schema-revision";

/** The STD API. */
export class StdApi extends HttpApi.make("std")
  .add(SignInGroup)
  .add(SessionGroup)
  .add(RecordsGroup)
  .prefix("/api/v1") {}
