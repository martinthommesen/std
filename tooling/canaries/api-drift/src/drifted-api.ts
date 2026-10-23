import { HttpApi } from "effect/http-api";

import { RecordsGroup } from "../../../../packages/api/src/records.ts";
import { TableMetadataGroup } from "../../../../packages/api/src/table-metadata.ts";
import { DriftedSessionGroup } from "./drifted-sign-in.ts";

/** The shared definition with the drifted sign-in and real groups. */
export class StdApi extends HttpApi.make("std")
  .add(DriftedSessionGroup)
  .add(TableMetadataGroup)
  .add(RecordsGroup)
  .prefix("/api/v1") {}
