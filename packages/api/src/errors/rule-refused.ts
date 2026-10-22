/**
 * `RuleRefused` (Contracts 4.10, HTTP 422).
 */
import { Schema } from "effect";

/**
 * A record rule's `refuse` action failed the save. Carries the rule's
 * fixed message, as its author wrote it, and nothing else.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class RuleRefused extends Schema.TaggedError<
  RuleRefused,
  { readonly brand: unique symbol }
>()("RuleRefused", { message: Schema.String }, { httpApiStatus: 422 }) {}
