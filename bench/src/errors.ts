/**
 * Errors of the benchmark harness.
 */
import { Schema } from "effect";

/** A failure of the benchmark harness itself (not a measured query). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class BenchError extends Schema.TaggedError<
  BenchError,
  { readonly brand: unique symbol }
>()("BenchError", {
  message: Schema.String,
}) {}
