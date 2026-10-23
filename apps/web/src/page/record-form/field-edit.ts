/** Every accepted field edit clears that field's prior server errors. */
import { Record } from "effect";
import { modifyFields } from "foldkit/struct";

import type { FieldInput } from "../../domain/form-input.ts";
import { Submission } from "./model.ts";
import type { Model } from "./model.ts";

/** Removes obsolete errors after an edit.
 * @param fieldId - The edited field.
 * @returns A step that preserves unrelated errors.
 */
export const forgetServerErrors =
  (fieldId: string) =>
  (model: Model): Model =>
    modifyFields(model, {
      serverErrors: Record.remove(fieldId),
      submission: (submission) =>
        Submission.guards.Saved(submission) ||
        Submission.guards.Unchanged(submission)
          ? Submission.Idle()
          : submission,
    });

/** Applies a user or definition-directed input through the same edit operation.
 * @param model - The form.
 * @param fieldId - The field's stable ID.
 * @param input - The accepted input.
 * @returns The form with the edit and obsolete errors removed.
 */
export const recordFieldEdit = (
  model: Model,
  fieldId: string,
  input: FieldInput
): Model =>
  forgetServerErrors(fieldId)(
    modifyFields(model, { edits: Record.set(fieldId, input) })
  );
