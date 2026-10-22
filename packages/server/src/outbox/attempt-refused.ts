/**
 * `AttemptRefused`: the worker did not run a claimed delivery's effect
 * (`worker.ts`, decision 0023).
 *
 * - `deadline`: the claim's effect deadline passed before the effect could
 *   start (a slow preparation, a saturated pool). Invoking it now could run
 *   it after the lease ended, beside another worker's claim, so the worker
 *   treats the claim as lost: nothing is recorded and the lease expires.
 * - `configuration`: the subscription's current configuration no longer
 *   runs this effect (disabled, retired, no longer served, or served by
 *   another kind of effect). The worker releases the claim.
 */
import { Schema } from "effect";

/** The worker did not run a claimed delivery's effect. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class AttemptRefused extends Schema.TaggedError<
  AttemptRefused,
  { readonly brand: unique symbol }
>()("AttemptRefused", {
  reason: Schema.Literals(["deadline", "configuration"]),
}) {}
