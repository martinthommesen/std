/** Preview requests follow the exact proposal; late answers cannot approve newer edits. */
import type { FormState } from "@std/api/form-state";
import { stringifyJson } from "@std/values/json";
// oxlint-disable-next-line sonarjs/no-built-in-override -- Foldkit requires Effect module names; this module does not use the global Array.
import { Array, Option, Record } from "effect";
import type { Update } from "foldkit";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { FieldInput, judgedBody } from "../../domain/form-input.ts";
import type { MetaField } from "../../domain/metadata.ts";
import { inputText, mergeDropped } from "../../domain/stale-edits.ts";
import { wireFieldOf } from "../../domain/wire.ts";
import type { StdApi } from "../../std-client.ts";
import { LoadFormState } from "./command.ts";
import { recordFieldEdit } from "./field-edit.ts";
import {
  checkForm,
  hasEditableSchema,
  isCreating,
  isReady,
  metaOf,
  recordOf,
  rulesOfForm,
  schemaFieldsOf,
} from "./form.ts";
import type { Message } from "./message.ts";
import { FormStateVerdict } from "./model.ts";
import type { Model } from "./model.ts";

/**
 * Requests a new verdict only when the proposal, record version or metadata changed.
 * @param model - The record form.
 * @returns A new verdict request only when the canonical proposal changed.
 */
export const requestFormState = (
  model: Model
): Update.Return<Model, Message, StdApi> => {
  const maybeMeta = metaOf(model);

  if (
    !isReady(model) ||
    !hasEditableSchema(model) ||
    Option.isNone(maybeMeta) ||
    rulesOfForm(model).length === 0
  ) {
    return { model };
  }

  const meta = maybeMeta.value;
  const maybeRecord = recordOf(model);

  if (
    !isCreating(model) &&
    !Option.contains(model.maybeRecordRevision, meta.revision)
  ) {
    return { model };
  }

  const values = judgedBody(checkForm(model).body);

  const id = Option.match(maybeRecord, {
    onNone: () => null,
    onSome: (record) => record.id,
  });

  const version = Option.match(maybeRecord, {
    onNone: () => null,
    onSome: (record) => record.version,
  });

  const key = stringifyJson({
    id,
    revision: meta.revision,
    table: model.table,
    values,
    version,
  });

  if (Option.contains(model.maybeFormStateKey, key)) {
    return { model };
  }

  const generation = model.formGeneration + 1;

  return {
    commands: [
      LoadFormState({
        fields: schemaFieldsOf(model).map(wireFieldOf),
        generation,
        recordId: id,
        recordVersion: version,
        schemaRevision: meta.revision,
        table: model.table,
        values,
      }),
    ],
    model: modifyFields(model, {
      formGeneration: () => generation,
      formState: (state) =>
        Option.match(AsyncData.getData(state), {
          onNone: () => FormStateVerdict.Loading(),
          onSome: (data) => FormStateVerdict.Refreshing({ data }),
        }),
      maybeFormStateKey: () => Option.some(key),
    }),
  };
};

/**
 * Applies the binding field states and definition-directed hidden-boolean corrections.
 * An edit removed by a verdict is not restored by a later verdict. This makes suppression
 * monotone, including self-referencing and mutually dependent hidden/read-only rules.
 * @param model - The form.
 * @param field - The field receiving this verdict.
 * @param verdict - The authoritative verdict.
 * @returns The form with a finite set of surviving or cleared edits.
 */
const applyFieldVerdict = (
  model: Model,
  field: MetaField,
  verdict: typeof FormState.Type
): Model => {
  const withheld = verdict.fields[field.name] === undefined;

  const state = verdict.fields[field.name] ?? {
    hidden: false,
    readOnly: true,
    required: false,
  };

  const clearing = state.hidden && state.clear?.allowed === true;
  const input = Record.get(model.edits, field.id);

  if (
    clearing &&
    verdict.values[field.name] === true &&
    !model.suppressedFormFields.includes(field.id) &&
    !model.automaticClears.includes(field.id)
  ) {
    return modifyFields(
      recordFieldEdit(model, field.id, FieldInput.Flag({ isChecked: false })),
      {
        automaticClears: (ids) => [...ids, field.id],
      }
    );
  }

  const cleared =
    clearing &&
    Option.exists(
      input,
      (value) => FieldInput.guards.Flag(value) && !value.isChecked
    );

  const suppress = (state.hidden || state.readOnly) && !cleared;

  if (!suppress || Option.isNone(input)) {
    return model;
  }

  return modifyFields(model, {
    droppedEdits: (notes) =>
      mergeDropped(notes, [
        {
          fieldId: field.id,
          label: field.label,
          maybeText: inputText(field, input.value),
          reason: withheld ? "Restricted" : "FormRule",
        },
      ]),
    edits: Record.remove(field.id),
    suppressedFormFields: (ids) =>
      ids.includes(field.id) ? ids : [...ids, field.id],
  });
};

/** Applies each field verdict, dropping suppressed edits once so dependent policies converge.
 * @param model - The form.
 * @param verdict - The authoritative verdict.
 * @returns The form with corrected and surviving edits.
 */
export const acceptFormState = (
  model: Model,
  verdict: typeof FormState.Type
): Model => {
  const fields = schemaFieldsOf(model);

  const hidden = new Set(
    fields.flatMap((field) =>
      verdict.fields[field.name]?.hidden === true ? [field.id] : []
    )
  );

  const accepted: Model = modifyFields(model, {
    automaticClears: (ids) => ids.filter((id) => hidden.has(id)),
    formState: () => FormStateVerdict.Success({ data: verdict }),
  });

  return Array.reduce(fields, accepted, (current, field) =>
    applyFieldVerdict(current, field, verdict)
  );
};

/** Current notices come from configuration and the current verdict, never from stale saved text.
 * @param model - The form.
 * @returns Notices about pending corrections and retained hidden flags.
 */
export const formNotices = (model: Model): readonly string[] =>
  Option.match(AsyncData.getData(model.formState), {
    onNone: () => [],
    onSome: (verdict) => {
      const automatic = new Set(model.automaticClears);
      const suppressed = new Set(model.suppressedFormFields);

      return schemaFieldsOf(model).flatMap((field) => {
        const state = verdict.fields[field.name];

        if (state?.hidden !== true || state.clear === undefined) {
          return [];
        }

        if (suppressed.has(field.id)) {
          return [
            `${field.label}: a form rule prevents an automatic correction here. Reload before trying that correction again.`,
          ];
        }

        if (automatic.has(field.id) && verdict.values[field.name] === true) {
          return AsyncData.isSuccess(model.formState)
            ? [
                `${field.label}: a derived value prevents the proposed correction.`,
              ]
            : [state.clear.notice];
        }

        return verdict.values[field.name] === true || automatic.has(field.id)
          ? [state.clear.notice]
          : [];
      });
    },
  });
