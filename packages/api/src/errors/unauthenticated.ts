/**
 * The `Unauthenticated` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** No valid session: no bearer token, an unknown or expired one, or an inactive user. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class Unauthenticated extends Schema.TaggedError<
  Unauthenticated,
  { readonly brand: unique symbol }
>()("Unauthenticated", {}, { httpApiStatus: 401 }) {}
