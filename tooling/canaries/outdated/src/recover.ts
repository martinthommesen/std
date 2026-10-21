import { Effect } from "effect";

/** Effect 3's `catchAll`, renamed to `catch` in Effect 4. */
// oxlint-disable-next-line import/namespace, typescript/no-unsafe-assignment, typescript/no-unsafe-call -- the outdatedApi canary must call an API that Effect 4 removed
export const recovered = Effect.catchAll(Effect.fail("boom"), () =>
  Effect.succeed(0)
);
