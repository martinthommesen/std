/**
 * `InvalidBody` (HTTP 400): a write body that is not a JSON object.
 */
import { Schema } from "effect";

/** The write body is not a JSON object of field values. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidBody extends Schema.TaggedError<
  InvalidBody,
  { readonly brand: unique symbol }
>()("InvalidBody", {}) {
  /** A fixed message that never echoes the body. */
  override readonly message = "The body must be a JSON object of field values";
}
