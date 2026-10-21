/**
 * The `UnknownTable` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A table that does not exist or that the caller has no allow on. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UnknownTable extends Schema.TaggedError<
  UnknownTable,
  { readonly brand: unique symbol }
>()("UnknownTable", { table: Schema.String }, { httpApiStatus: 404 }) {}
