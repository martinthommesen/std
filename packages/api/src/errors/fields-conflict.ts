/**
 * `FieldsConflict` (Contracts 10.3, HTTP 409, `/api/v2` only): a `fields`
 * selection that both includes and excludes (`!name`) the same attribute
 * (TMF630 v5.0.0 Part 1 §4.3 pp.50-57).
 */
import { Schema } from "effect";

/** `fields` includes and excludes the same attribute. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class FieldsConflict extends Schema.TaggedError<
  FieldsConflict,
  { readonly brand: unique symbol }
>()("FieldsConflict", { field: Schema.String }, { httpApiStatus: 409 }) {}
