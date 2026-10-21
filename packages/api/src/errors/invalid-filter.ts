/**
 * The `InvalidFilter` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

import { FilterIssueSchema } from "./schemas.ts";

/** A filter that does not parse or check (names resolve first: `UnknownField`). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidFilter extends Schema.TaggedError<
  InvalidFilter,
  { readonly brand: unique symbol }
>()(
  "InvalidFilter",
  { issues: Schema.Array(FilterIssueSchema) },
  { httpApiStatus: 400 }
) {}
