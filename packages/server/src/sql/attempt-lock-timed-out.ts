/**
 * The internal failure of one config commit attempt that hit its lock
 * timeout (`config-commit.ts`): the retry policy matches it, and it becomes
 * `SchemaLockTimeout` when the policy gives up.
 */
import { Schema } from "effect";

/**
 * A relation lock an attempt was seen waiting for: the oids of its database
 * and relation (relation oids are unique only within one database) and the
 * requested mode.
 */
export const WaitedLockSchema = Schema.Struct({
  database: Schema.String,
  mode: Schema.String,
  relation: Schema.String,
});

/** A relation lock an attempt was seen waiting for. */
export type WaitedLock = typeof WaitedLockSchema.Type;

/**
 * An attempt hit its lock timeout. `blockers` are every PID seen blocking it
 * while it waited; `waited` is the last relation lock it was seen waiting
 * for, if any.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class AttemptLockTimedOut extends Schema.TaggedError<AttemptLockTimedOut>()(
  "AttemptLockTimedOut",
  {
    blockers: Schema.Array(Schema.Int),
    waited: Schema.optional(WaitedLockSchema),
  }
) {}
