/**
 * The `InvalidRequest` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** A malformed request parameter or body; forbidden bodies carry byte details. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidRequest extends Schema.TaggedError<
  InvalidRequest,
  { readonly brand: unique symbol }
>()(
  "InvalidRequest",
  {
    limit: Schema.optionalKey(Schema.Finite),
    message: Schema.String,
    parameter: Schema.String,
    received: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  },
  { httpApiStatus: 400 }
) {}
