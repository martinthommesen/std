import { Effect } from "effect";

/** Stable `Effect` passes the stability diagnostics but not the import check. */
export const answer = Effect.succeed(42);
