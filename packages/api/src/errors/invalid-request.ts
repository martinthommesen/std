/**
 * The `InvalidRequest` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A malformed query parameter (`limit`, `sort`, `fields`, `count`, ...). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidRequest extends Schema.TaggedError<
  InvalidRequest,
  { readonly brand: unique symbol }
>()(
  "InvalidRequest",
  { message: Schema.String, parameter: Schema.String },
  { httpApiStatus: 400 }
) {}
