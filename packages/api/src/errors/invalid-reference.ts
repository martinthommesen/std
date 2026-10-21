/**
 * `InvalidReference` (Contracts 3.6, 3.8, HTTP 422).
 */
import { Schema } from "effect";

/**
 * A reference field names a target that does not exist or that the caller
 * cannot see. Both cases are identical.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidReference extends Schema.TaggedError<
  InvalidReference,
  { readonly brand: unique symbol }
>()(
  "InvalidReference",
  {
    /** The reference field's API name. */
    field: Schema.String,
  },
  { httpApiStatus: 422 }
) {
  /**
   * Names the field, never the target.
   * @returns The message.
   */
  override get message(): string {
    return `The record that ${JSON.stringify(this.field)} refers to does not exist`;
  }
}
