import { HttpApi } from "effect/http-api";

import { Tmf688Group, TMF688_PREFIX } from "./tmf688.ts";

/** TMF688 at its pinned path, independent of the generic API version. */
export class Tmf688Api extends HttpApi.make("tmf688")
  .add(Tmf688Group)
  .prefix(TMF688_PREFIX) {}
