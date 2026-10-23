/** Field errors from write/check refusals, keyed by the caller's stable field IDs. */
import { Option } from "effect";

import type { MetaField } from "../../domain/metadata.ts";
import { errorsByFieldId } from "./form.ts";
import { WriteError } from "./model.ts";

const INVALID_REFERENCE_TEXT =
  "The chosen record is not available here: it does not exist, you cannot see it, or this field does not allow it.";

const UNKNOWN_FIELD_TEXT =
  "The server does not know this field for you any more. Reload the definition.";

const fieldIdByName = (
  fields: readonly MetaField[],
  name: string
): Option.Option<string> =>
  Option.fromNullishOr(fields.find((field) => field.name === name)?.id);

/** Maps only refusals with field details; callers own the refusal's lifetime.
 * @param fields - The caller-visible fields.
 * @param error - The refused write or check.
 * @returns Messages by stable field ID.
 */
export const serverErrorsOf = (
  fields: readonly MetaField[],
  error: WriteError
): Readonly<Record<string, readonly string[]>> => {
  if (WriteError.guards.ValidationFailed(error)) {
    return errorsByFieldId(fields, error.errors);
  }

  if (WriteError.guards.InvalidReference(error)) {
    return Option.match(fieldIdByName(fields, error.field), {
      onNone: () => ({}),
      onSome: (fieldId) => ({ [fieldId]: [INVALID_REFERENCE_TEXT] }),
    });
  }

  return WriteError.guards.UnknownField(error)
    ? Option.match(fieldIdByName(fields, error.field), {
        onNone: () => ({}),
        onSome: (fieldId) => ({ [fieldId]: [UNKNOWN_FIELD_TEXT] }),
      })
    : {};
};
