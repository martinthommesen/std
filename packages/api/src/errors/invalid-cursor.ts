/**
 * The `InvalidCursor` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A cursor that is not one this endpoint issued for this sort. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidCursor extends Schema.TaggedError<
  InvalidCursor,
  { readonly brand: unique symbol }
>()("InvalidCursor", {}, { httpApiStatus: 400 }) {}
