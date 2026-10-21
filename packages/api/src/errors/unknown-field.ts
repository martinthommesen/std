/**
 * The `UnknownField` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A field name that does not exist or is never readable (Contracts 3.4). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UnknownField extends Schema.TaggedError<
  UnknownField,
  { readonly brand: unique symbol }
>()("UnknownField", { field: Schema.String }, { httpApiStatus: 400 }) {}
