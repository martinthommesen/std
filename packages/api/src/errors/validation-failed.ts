import { FieldErrorSchema } from "@std/definitions/field-errors";
/**
 * `ValidationFailed` (Contracts 3.8, HTTP 422): every field error of a
 * write, returned together (6.7).
 */
import { Schema } from "effect";

/**
 * A write was refused because of its values. Lists field errors only for
 * fields the caller supplied or can read.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ValidationFailed extends Schema.TaggedError<
  ValidationFailed,
  { readonly brand: unique symbol }
>()(
  "ValidationFailed",
  { errors: Schema.Array(FieldErrorSchema) },
  { httpApiStatus: 422 }
) {
  /**
   * Names the fields and error kinds, never a value.
   * @returns The message.
   */
  override get message(): string {
    const listed = this.errors
      .map((error) => `${error.field}: ${error._tag}`)
      .join(", ");

    return `The record is not valid (${listed})`;
  }
}
