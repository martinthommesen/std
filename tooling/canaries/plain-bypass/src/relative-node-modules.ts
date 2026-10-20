// oxlint-disable-next-line sonarjs/no-internal-api-use -- the canary imports Effect through a path into node_modules
import type { succeed } from "../../../../node_modules/effect/dist/Effect.js";

/** A relative path into node_modules loads stable Effect. */
export type ViaRelativePath = typeof succeed;
