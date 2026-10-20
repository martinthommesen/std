import { Effect } from "effect";

import { secondCopy } from "../second/copy.ts";

/**
 * Uses the root `effect` and, through `../second`, a second copy that the
 * canary test writes into `second/node_modules/effect` before type-checking.
 */
export const both = Effect.succeed(secondCopy);
