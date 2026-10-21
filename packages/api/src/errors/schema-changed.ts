/**
 * The `SchemaChanged` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

import { SchemaChangeSchema } from "./schemas.ts";

/** The request was built at a revision whose relevant definitions changed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaChanged extends Schema.TaggedError<
  SchemaChanged,
  { readonly brand: unique symbol }
>()(
  "SchemaChanged",
  {
    changes: Schema.Array(SchemaChangeSchema),
    currentRevision: Schema.String,
    requestRevision: Schema.String,
  },
  { httpApiStatus: 409 }
) {}
