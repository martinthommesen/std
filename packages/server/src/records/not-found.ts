/**
 * `NotFound` (Contracts 3.8, HTTP 404).
 */
import { Schema } from "effect";

/**
 * The record does not exist, is not visible to the caller, or is outside
 * the endpoint's subtree. The three cases are identical (Contracts 2.3).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class NotFound extends Schema.TaggedError<
  NotFound,
  { readonly brand: unique symbol }
>()("NotFound", {}) {
  /** A fixed message that names nothing. */
  override readonly message = "The record does not exist";
}
