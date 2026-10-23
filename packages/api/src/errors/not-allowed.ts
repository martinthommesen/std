/**
 * `NotAllowed` (Contracts 3.8, HTTP 403).
 */
import { Schema } from "effect";

/**
 * Access rules refuse the write on a visible record, or refuse a create.
 * Names no rule. `refusedOn: "owner"` says that the refusal came from an
 * owner of the part being written (Contracts 4.9, decision 0039): the
 * caller may read that owner but not update it. It names no owner, since
 * the part's owner reference may be hidden from the caller.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class NotAllowed extends Schema.TaggedError<
  NotAllowed,
  { readonly brand: unique symbol }
>()(
  "NotAllowed",
  { refusedOn: Schema.optionalKey(Schema.Literal("owner")) },
  { httpApiStatus: 403 }
) {
  /**
   * A fixed text that names nothing, one per kind of refusal.
   * @returns The message.
   */
  override get message(): string {
    return this.refusedOn === "owner"
      ? "Writing this part needs the right to update its owner"
      : "The operation is not allowed";
  }
}
