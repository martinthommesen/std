/**
 * The `VersionRequired` API error (Contracts 3.8, 6.7).
 */
import { Schema } from "effect";

/** A `PATCH` or `DELETE` without `If-Match: "<version>"`; nothing changed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class VersionRequired extends Schema.TaggedError<
  VersionRequired,
  { readonly brand: unique symbol }
>()("VersionRequired", {}, { httpApiStatus: 428 }) {}
