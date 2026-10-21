/**
 * `NotAllowed` (Contracts 3.8, HTTP 403).
 */
import { Schema } from "effect";

/**
 * Access rules refuse the write on a visible record, or refuse a create.
 * Names no rule.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class NotAllowed extends Schema.TaggedError<
  NotAllowed,
  { readonly brand: unique symbol }
>()("NotAllowed", {}, { httpApiStatus: 403 }) {
  /** A fixed message that names nothing. */
  override readonly message = "The operation is not allowed";
}
