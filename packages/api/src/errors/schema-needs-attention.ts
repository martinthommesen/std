/**
 * `SchemaNeedsAttention` (Contracts 1.5, HTTP 409).
 */
import { Schema } from "effect";

/**
 * A change set with DDL waits until an operator resumes or abandons the
 * change set that needs attention.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaNeedsAttention extends Schema.TaggedError<
  SchemaNeedsAttention,
  { readonly brand: unique symbol }
>()(
  "SchemaNeedsAttention",
  { changeSetId: Schema.String },
  { httpApiStatus: 409 }
) {
  /**
   * Names the change set.
   * @returns The message.
   */
  override get message(): string {
    return `Change set ${this.changeSetId} needs attention`;
  }
}
