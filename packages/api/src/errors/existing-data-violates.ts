/**
 * `ExistingDataViolates` (Contracts 1.4, HTTP 409).
 */
import { Schema } from "effect";

/** Existing records violate a tightening; nothing was applied. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ExistingDataViolates extends Schema.TaggedError<
  ExistingDataViolates,
  { readonly brand: unique symbol }
>()(
  "ExistingDataViolates",
  {
    count: Schema.Int,
    definitionId: Schema.String,
    /** Up to 20 IDs of violating records. */
    sampleIds: Schema.Array(Schema.String),
  },
  { httpApiStatus: 409 }
) {
  /**
   * Names the definition and the count.
   * @returns The message.
   */
  override get message(): string {
    return `${this.count} existing records violate ${this.definitionId}`;
  }
}
