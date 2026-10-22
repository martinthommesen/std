/**
 * `InvalidTransition` (Contracts 4.10, 14, HTTP 422).
 */
import { Schema } from "effect";

/**
 * A record rule's `refuse` action with code `InvalidTransition` failed the
 * save: a state change its rules do not allow. Carries the rule's fixed
 * message, as its author wrote it, and nothing else.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidTransition extends Schema.TaggedError<
  InvalidTransition,
  { readonly brand: unique symbol }
>()("InvalidTransition", { message: Schema.String }, { httpApiStatus: 422 }) {}
