/** Non-persisting form verdicts on the generic API (Contracts 6.3, decision 0036). */
import { DefinitionIdSchema } from "@std/definitions/ids";
import { Schema } from "effect";

/** A typed write-only value is present; its plaintext is never part of a preview. */
export const FormSecretPresence = Schema.Struct({ set: Schema.Literal(true) });

/** A create (null ID/revision) or versioned update proposal; values use API attribute names. */
export const FormStateRequest = Schema.Struct({
  id: Schema.NullOr(DefinitionIdSchema),
  revision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  table: Schema.String,
  values: Schema.Record(Schema.String, Schema.Json),
});

/** The binding state of one readable field. */
export const FormFieldState = Schema.Struct({
  choices: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  clear: Schema.optionalKey(
    Schema.Struct({ allowed: Schema.Boolean, notice: Schema.String })
  ),
  hidden: Schema.Boolean,
  readOnly: Schema.Boolean,
  required: Schema.Boolean,
});

/** A verdict for exactly the submitted proposal, never a permission to save another version. */
export const FormState = Schema.Struct({
  fields: Schema.Record(Schema.String, FormFieldState),
  messages: Schema.optionalKey(Schema.Array(Schema.String)),
  revision: Schema.NullOr(Schema.Int),
  schemaRevision: Schema.Int,
  values: Schema.Record(Schema.String, Schema.Json),
});
