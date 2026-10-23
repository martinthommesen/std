/**
 * `MethodNotAllowed` (Contracts 10.5, HTTP 405, `/api/v1` only): `PUT`,
 * which TMF630 v5.0.0 Part 1 §3.1 p.27 says not to use, or any other method
 * a resource does not offer. `allow` lists the methods it does.
 */
import { Schema } from "effect";

/** The method is not allowed on this resource. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class MethodNotAllowed extends Schema.TaggedError<
  MethodNotAllowed,
  { readonly brand: unique symbol }
>()("MethodNotAllowed", { allow: Schema.String }, { httpApiStatus: 405 }) {}
