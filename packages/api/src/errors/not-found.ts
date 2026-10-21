/**
 * The `NotFound` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A record that does not exist or is not visible; identical either way. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class NotFound extends Schema.TaggedError<
  NotFound,
  { readonly brand: unique symbol }
>()("NotFound", {}, { httpApiStatus: 404 }) {}
