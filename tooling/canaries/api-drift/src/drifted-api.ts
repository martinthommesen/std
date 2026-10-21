import { HttpApi } from "effect/http-api";

import { RecordsGroup } from "../../../../packages/api/src/records.ts";
import { RequestDecoding } from "../../../../packages/api/src/request-decoding.ts";
import { SessionGroup } from "../../../../packages/api/src/session.ts";
import { DriftedSignInGroup } from "./drifted-sign-in.ts";

/** The shared definition with the drifted sign-in and every real group. */
export class StdApi extends HttpApi.make("std")
  .add(DriftedSignInGroup)
  .add(SessionGroup)
  .add(RecordsGroup)
  .middleware(RequestDecoding)
  .prefix("/api/v1") {}
