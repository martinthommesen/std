/**
 * `DeliveryFailed`: the typed failure a delivery effect reports
 * (`delivery-effects.ts`). Its `reason` goes to `last_error`.
 */
import { Schema } from "effect";

/**
 * A delivery effect failed. `reason` is for operators and must hold no
 * secret and no field value (Contracts 4.3).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DeliveryFailed extends Schema.TaggedError<
  DeliveryFailed,
  { readonly brand: unique symbol }
>()("DeliveryFailed", {
  /** For operators; no secret and no field value (4.3). */
  reason: Schema.String,
}) {
  /**
   * The reason.
   * @returns The message.
   */
  override get message(): string {
    return this.reason;
  }
}
