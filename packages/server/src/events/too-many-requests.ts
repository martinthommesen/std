import { Schema } from "effect";

/** Registration exceeded its serialized per-identity allowance. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class TooManyRequests extends Schema.TaggedError<
  TooManyRequests,
  { readonly brand: unique symbol }
>()("TooManyRequests", {}) {}
