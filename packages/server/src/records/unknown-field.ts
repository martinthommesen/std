/**
 * `UnknownField` (Contracts 3.4, 3.8, HTTP 400).
 */
import { Schema } from "effect";

/**
 * A name in the request resolves to no field the caller may name: a
 * misspelling and a never-readable field give the same error.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UnknownField extends Schema.TaggedError<
  UnknownField,
  { readonly brand: unique symbol }
>()("UnknownField", {
  /** The name as the request spelled it. */
  field: Schema.String,
}) {
  /**
   * Names the field as the caller spelled it.
   * @returns The message.
   */
  override get message(): string {
    return `Unknown field ${JSON.stringify(this.field)}`;
  }
}
