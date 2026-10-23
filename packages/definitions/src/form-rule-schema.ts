/** Form-only field policies and their serialized configuration. */
import { Schema } from "effect";

/** A hidden boolean may be cleared by the form when the caller may write it. */
export const ClearHiddenSchema = Schema.Struct({
  clearedNotice: Schema.String,
  retainedNotice: Schema.String,
});

/** Choice restrictions use stable choice keys; other assignments use booleans. */
export const FormRuleValueSchema = Schema.Union([
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

/** The properties a form rule may constrain, without restricting API writes. */
export const FormRulePropertySchema = Schema.Literals([
  "required",
  "readOnly",
  "hidden",
  "choices",
]);
