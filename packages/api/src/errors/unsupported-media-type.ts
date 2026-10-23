/**
 * `UnsupportedMediaType` (Contracts 10.5, HTTP 415, `/api/v1` only): a
 * `PATCH` body in a media type STD does not accept, such as
 * `application/json-patch-query+json` (exclusion E15). `accepted` lists the
 * ones it does.
 */
import { Schema } from "effect";

/** The body's media type is not supported here. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UnsupportedMediaType extends Schema.TaggedError<
  UnsupportedMediaType,
  { readonly brand: unique symbol }
>()(
  "UnsupportedMediaType",
  { accepted: Schema.Array(Schema.String) },
  { httpApiStatus: 415 }
) {}
