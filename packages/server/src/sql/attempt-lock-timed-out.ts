/**
 * The internal failure of one config commit attempt that hit its lock
 * timeout (`config-commit.ts`): the retry policy matches it, and it becomes
 * `SchemaLockTimeout` when the policy gives up.
 */
import { Schema } from "effect";

/** An attempt hit its lock timeout; `blockers` are the PIDs sampled while it waited. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class AttemptLockTimedOut extends Schema.TaggedError<AttemptLockTimedOut>()(
  "AttemptLockTimedOut",
  { blockers: Schema.Array(Schema.Int) }
) {}
