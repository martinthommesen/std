/**
 * `Referenced` (Contracts 3.8, 3.10, HTTP 409).
 */
import { Schema } from "effect";

/**
 * A delete was refused because other records reference the record. Carries
 * no count, ID or name: that some reference exists is the accepted leak.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class Referenced extends Schema.TaggedError<
  Referenced,
  { readonly brand: unique symbol }
>()("Referenced", {}) {
  /** A fixed message that names nothing. */
  override readonly message = "Other records refer to this record";
}
