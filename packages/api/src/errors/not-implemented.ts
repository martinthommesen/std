/**
 * `NotImplemented` (Contracts 10.3, HTTP 501, `/api/v1` only): a JSONPath
 * `filter`, which STD does not support (exclusion E14). TMF630 v5.0.0
 * Part 6 §8 p.53 answers an unsupported JSONPath with 501.
 */
import { Schema } from "effect";

/** A feature of the request is not implemented; `reason` says which. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class NotImplemented extends Schema.TaggedError<
  NotImplemented,
  { readonly brand: unique symbol }
>()(
  "NotImplemented",
  { feature: Schema.Literal("jsonPathNotSupported") },
  { httpApiStatus: 501 }
) {}
