/**
 * The field errors a `ValidationFailed` lists (Contracts 3.8, 6.7):
 * `InvalidValue`, `Required`, `ReadOnlyField` and `DefinitionRetired`.
 *
 * Each names the field by its API name and never carries the refused value,
 * so an error can be returned or logged without leaking a password, a
 * secret or a hidden value (Contracts 4.3).
 */
import { InvalidValueReasonSchema } from "@std/values/field-error";
import type { InvalidValue } from "@std/values/field-error";
import { Schema } from "effect";

/**
 * Why a value is invalid: every reason of `@std/values`, plus `notUnique`
 * for a unique index violation (the accepted leak of Contracts 3.8: the
 * value is taken).
 */
export const FieldValueReasonSchema = Schema.Literals([
  ...InvalidValueReasonSchema.literals,
  "notUnique",
]);

/** A reason code of an `InvalidValue` field error. */
export type FieldValueReason = typeof FieldValueReasonSchema.Type;

/** The value does not convert under the field's type and settings (6.5). */
export const InvalidValueErrorSchema = Schema.TaggedStruct("InvalidValue", {
  field: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  message: Schema.String,
  reason: FieldValueReasonSchema,
});

/** An `InvalidValue` field error. */
export type InvalidValueError = typeof InvalidValueErrorSchema.Type;

/** A required field (with the overrides of the concrete class) is empty. */
export const RequiredErrorSchema = Schema.TaggedStruct("Required", {
  field: Schema.String,
});

/** A `Required` field error. */
export type RequiredError = typeof RequiredErrorSchema.Type;

/** A system field, or a read-only field, is written. */
export const ReadOnlyFieldErrorSchema = Schema.TaggedStruct("ReadOnlyField", {
  field: Schema.String,
});

/** A `ReadOnlyField` field error. */
export type ReadOnlyFieldError = typeof ReadOnlyFieldErrorSchema.Type;

/** A retired field is written (Contracts 1.6). */
export const DefinitionRetiredErrorSchema = Schema.TaggedStruct(
  "DefinitionRetired",
  { field: Schema.String }
);

/** A `DefinitionRetired` field error. */
export type DefinitionRetiredError = typeof DefinitionRetiredErrorSchema.Type;

/** Any field error of `ValidationFailed`. */
export const FieldErrorSchema = Schema.Union([
  InvalidValueErrorSchema,
  RequiredErrorSchema,
  ReadOnlyFieldErrorSchema,
  DefinitionRetiredErrorSchema,
]);

/** A field error. */
export type FieldError = typeof FieldErrorSchema.Type;

/**
 * The field error of a refused conversion.
 *
 * @param field - The field's API name.
 * @param error - The refusal from `@std/values`.
 * @returns An `InvalidValue` field error with the same reason and message.
 */
export const invalidValue = (
  field: string,
  error: InvalidValue
): InvalidValueError =>
  error.hint === undefined
    ? {
        _tag: "InvalidValue",
        field,
        message: error.message,
        reason: error.reason,
      }
    : {
        _tag: "InvalidValue",
        field,
        hint: error.hint,
        message: error.message,
        reason: error.reason,
      };
