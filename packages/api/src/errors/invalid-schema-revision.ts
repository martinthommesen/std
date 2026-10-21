/**
 * The `InvalidSchemaRevision` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A malformed `STD-Schema-Revision` request header (Contracts 6.4). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidSchemaRevision extends Schema.TaggedError<
  InvalidSchemaRevision,
  { readonly brand: unique symbol }
>()("InvalidSchemaRevision", {}, { httpApiStatus: 400 }) {}
