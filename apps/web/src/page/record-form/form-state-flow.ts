/** Preview requests follow the exact proposal; late answers cannot approve newer edits. */
import type { FormState } from "@std/api/form-state";
import { stringifyJson } from "@std/values/json";
// oxlint-disable-next-line sonarjs/no-built-in-override -- Foldkit requires Effect module names; this module does not use the global Array.
import { Array, Match, Option, Record } from "effect";
import type { Update } from "foldkit";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";

import {
  FieldInput,
  buildBody,
  formStateBody,
} from "../../domain/form-input.ts";
import type { MetaField } from "../../domain/metadata.ts";
import { inputText, mergeDropped } from "../../domain/stale-edits.ts";
import { wireFieldOf } from "../../domain/wire.ts";
import type { StdApi } from "../../std-client.ts";
import { LoadFormState } from "./command.ts";
import { recordFieldEdit } from "./field-edit.ts";
import {
  editedFieldsOf,
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
import type { Model, WriteError } from "./model.ts";

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

  const values = formStateBody(buildBody(editedFieldsOf(model)).body);

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

  const unchanged = Option.contains(model.maybeFormStateKey, key);

  if (
    unchanged &&
    (Option.isSome(model.maybeFormStateInFlight) ||
      !AsyncData.isPending(model.formState))
  ) {
    return { model };
  }

  const generation = unchanged
    ? model.formGeneration
    : model.formGeneration + 1;

  const pending = modifyFields(model, {
    formGeneration: () => generation,
    formState: (state) =>
      Option.match(AsyncData.getData(state), {
        onNone: () => FormStateVerdict.Loading(),
        onSome: (data) => FormStateVerdict.Refreshing({ data }),
      }),
    maybeFormStateKey: () => Option.some(key),
  });

  // The Model keeps the latest proposal. Only completion releases the request slot.
  if (Option.isSome(model.maybeFormStateInFlight)) {
    return { model: pending };
  }

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
    model: modifyFields(pending, {
      maybeFormStateInFlight: () => Option.some(generation),
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

/**
 * Describes a refused verdict without repeating private values.
 * @param error - The check refusal.
 * @returns Its actionable explanation.
 */
export const checkErrorText = (error: WriteError): string =>
  Match.value(error).pipe(
    Match.tag(
      "Unavailable",
      () =>
        "The server did not answer the form check. Your input is kept; try again."
    ),
    Match.tag(
      "ValidationFailed",
      () => "The form could not be checked: review the marked fields."
    ),
    Match.tag(
      "InvalidReference",
      () =>
        "The form could not be checked: a chosen record is not available here."
    ),
    Match.tag(
      "UnknownField",
      () =>
        "The form could not be checked: a field is no longer available to you. Reload the definition."
    ),
    Match.tag(
      "NotAllowed",
      () => "You are not allowed to make this proposed change."
    ),
    Match.tag(
      "NotFound",
      () => "This record no longer exists, or you can no longer see it."
    ),
    Match.tag(
      "VersionConflict",
      ({ currentVersion }) =>
        `The record changed to version ${currentVersion}. Reload it, keeping your changes, before checking the form again.`
    ),
    Match.tag(
      "SchemaChanged",
      () =>
        "The definition changed. Your input is kept while the definition reloads."
    ),
    Match.tag(
      "Referenced",
      () => "The proposed change conflicts with records that refer to this one."
    ),
    Match.tag(
      "Refused",
      ({ message }) => `The form check was refused: ${message}`
    ),
    Match.exhaustive
  );

/**
 * Keeps the live announcement stable while checking, and changes it only for a different verdict on permitted interaction.
 * @param model - The completed form check or its successor proposal.
 * @returns The form with a persistent screen-reader announcement.
 */
export const announceFormState = (model: Model): Model => {
  const error = AsyncData.getError(model.formState);

  if (Option.isSome(error)) {
    return modifyFields(model, {
      formAnnouncement: () => checkErrorText(error.value),
    });
  }

  if (!AsyncData.isSuccess(model.formState)) {
    return model;
  }

  const verdict = model.formState.data;

  const restrictions = schemaFieldsOf(model).flatMap((field) => {
    const state = verdict.fields[field.name];

    if (state === undefined) {
      return [`${field.label}: restricted.`];
    }

    const properties = Object.entries({
      hidden: state.hidden,
      "read-only": state.readOnly,
      required: state.required,
    }).flatMap(([property, applies]) => (applies ? [property] : []));

    const offered =
      state.choices === undefined || state.choices === null
        ? properties
        : [...properties, `choices ${state.choices.join(", ")}`];

    return offered.length === 0
      ? []
      : [`${field.label}: ${offered.join(", ")}.`];
  });

  return modifyFields(model, {
    formAnnouncement: () =>
      [
        "Form rules checked.",
        ...restrictions,
        ...formNotices(model),
        ...(verdict.messages ?? []),
      ].join(" "),
  });
};
