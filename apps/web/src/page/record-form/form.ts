/**
 * What the form page derives from its Model, for `update` and `view`
 * alike: the fields, each field's input and base value, the write body,
 * and the problems the client finds with it (Contracts 6.3: the same
 * verdict as the server's for every field both see).
 */
import { Combobox, DatePicker } from "@foldkit/ui";
import type { RecordJson } from "@std/api/records";
import type { FieldError } from "@std/definitions/field-errors";
import { validateRecord } from "@std/definitions/record-schema";
import type { RecordVerdict } from "@std/definitions/record-schema";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import type { JsonValue } from "@std/values/json-value";
import { Match, Option, Record, pipe } from "effect";
import { AsyncData } from "foldkit";

import {
  definitionProblems,
  withRecordLimits,
} from "../../domain/definition-limits.ts";
import { fieldShowOf, formFieldsOf } from "../../domain/form-fields.ts";
import {
  buildBody,
  createBaseValue,
  inputOfValue,
  judgedBody,
} from "../../domain/form-input.ts";
import type {
  BodyField,
  FormBody,
  FieldInput,
} from "../../domain/form-input.ts";
import type { TableMeta } from "../table-list/model.ts";
import { FormMode } from "./model.ts";
import type { Model } from "./model.ts";

/**
 * The endpoint's metadata, when the page has some.
 *
 * @param model - The page.
 * @returns The metadata and its revision.
 */
export const metaOf = (model: Model): Option.Option<TableMeta> =>
  AsyncData.getData(model.metadata);

/**
 * The record, when the page edits one and has read it.
 *
 * @param model - The page.
 * @returns The record.
 */
export const recordOf = (model: Model): Option.Option<RecordJson> =>
  AsyncData.getData(model.record);

/**
 * Whether the page creates a record.
 *
 * @param model - The page.
 * @returns True on `/tables/:table/new`.
 */
export const isCreating = (model: Model): boolean =>
  FormMode.guards.Create(model.mode);

/**
 * The concrete class's metadata, when the record's class differs from the
 * endpoint and the page has it.
 *
 * @param model - The page.
 * @returns The class's metadata.
 */
export const classMetaOf = (model: Model): Option.Option<MetaTable> =>
  AsyncData.getData(model.classMetadata);

/**
 * Whether the form can be shown: metadata, and the record when editing.
 *
 * @param model - The page.
 * @returns True once both arrived.
 */
export const isReady = (model: Model): boolean =>
  Option.isSome(metaOf(model)) &&
  (isCreating(model) || Option.isSome(recordOf(model)));

/**
 * The record the form edits, as `fieldShowOf` takes it: none on create.
 *
 * @param model - The page.
 * @returns The record.
 */
export const editedRecordOf = (model: Model): Option.Option<RecordJson> =>
  isCreating(model) ? Option.none() : recordOf(model);

/**
 * The fields of the endpoint as the form describes them (decision 0020):
 * the concrete class's description when the page has it, with the schema
 * engine's per-record limits of a definition table applied
 * (`definition-limits.ts`).
 *
 * @param model - The page.
 * @returns The fields; none before the metadata arrives.
 */
export const fieldsOf = (model: Model): readonly MetaField[] =>
  Option.match(metaOf(model), {
    onNone: () => [],
    onSome: (meta) =>
      withRecordLimits(
        meta.table.name,
        formFieldsOf(meta.table, classMetaOf(model)),
        editedRecordOf(model)
      ),
  });

/**
 * A field by ID, as the form describes it.
 *
 * @param model - The page.
 * @param fieldId - The field's ID.
 * @returns The field.
 */
export const fieldOf = (
  model: Model,
  fieldId: string
): Option.Option<MetaField> =>
  Option.fromNullishOr(fieldsOf(model).find((field) => field.id === fieldId));

/**
 * What a field holds before the user changes it: the stored value when
 * editing, what a create stores without it otherwise (Contracts 6.7).
 *
 * @param model - The page.
 * @param field - The field.
 * @returns The value.
 */
export const baseValueOf = (model: Model, field: MetaField): JsonValue =>
  Option.match(editedRecordOf(model), {
    onNone: () => createBaseValue(field),
    onSome: (record) => record.values[field.name] ?? null,
  });

/**
 * A reference's label in the record as read, when permitted (3.6).
 *
 * @param model - The page.
 * @param field - The field.
 * @returns The label.
 */
export const storedLabelOf = (
  model: Model,
  field: MetaField
): Option.Option<string> =>
  Option.flatMap(editedRecordOf(model), (record) =>
    Option.fromNullishOr(record.labels?.[field.name])
  );

/**
 * A field's input: the user's edit, else its base value as an input.
 *
 * @param model - The page.
 * @param field - The field.
 * @returns The input.
 */
export const inputOf = (model: Model, field: MetaField): FieldInput =>
  Option.getOrElse(Record.get(model.edits, field.id), () =>
    inputOfValue(field, baseValueOf(model, field), storedLabelOf(model, field))
  );

/**
 * The ID of a reference field's Combobox.
 *
 * @param fieldId - The field's ID.
 * @returns The ID.
 */
export const pickerIdOf = (fieldId: string): string =>
  `field-${fieldId}-picker`;

/**
 * The ID of a date or date-time field's Date Picker.
 *
 * @param fieldId - The field's ID.
 * @returns The ID.
 */
export const datePickerIdOf = (fieldId: string): string =>
  `field-${fieldId}-date`;

/**
 * The element ID of a field's control, which its label names and focus
 * moves to: the input itself, the Combobox's input, or the Date Picker's
 * trigger.
 *
 * @param field - The field.
 * @returns The ID.
 */
export const controlIdOf = (field: MetaField): string =>
  Match.value(field.type.kind).pipe(
    Match.when("reference", () => Combobox.inputId(pickerIdOf(field.id))),
    Match.whenOr("date", "dateTime", () =>
      DatePicker.triggerId(datePickerIdOf(field.id))
    ),
    Match.orElse(() => `field-${field.id}`)
  );

/**
 * The fields the body may carry: those with an edit that the form shows
 * as editable (a restricted, undelivered or read-only field is never
 * sent, whatever the Model holds).
 *
 * @param model - The page.
 * @returns Each with its input and base value.
 */
export const editedFieldsOf = (model: Model): readonly BodyField[] => {
  const maybeRecord = editedRecordOf(model);

  return fieldsOf(model).flatMap((field) =>
    Option.match(Record.get(model.edits, field.id), {
      onNone: () => [],
      onSome: (input) =>
        fieldShowOf(field, maybeRecord)._tag === "Editable"
          ? [{ base: baseValueOf(model, field), field, input }]
          : [],
    })
  );
};

/**
 * The client's verdict on a body, as the server will give it: create mode
 * with the endpoint's metadata; update mode with the concrete class's
 * metadata and `through` the endpoint when the class differs (decision
 * 0017). Without the class's metadata (the caller cannot open that table)
 * the client finds nothing and the server decides.
 *
 * @param model - The page.
 * @param body - The body as `recordSchema` judges it.
 * @returns The verdict, if the client can give one.
 */
export const verdictOf = (
  model: Model,
  body: Readonly<Record<string, JsonValue>>
): Option.Option<RecordVerdict> =>
  Option.flatMap(metaOf(model), (meta) =>
    Option.match(editedRecordOf(model), {
      onNone: () => Option.some(validateRecord(meta.table, "create", body)),
      onSome: (record) => {
        const stored = { class: record.class, values: record.values };

        if (record.class === meta.table.name) {
          return Option.some(
            validateRecord(meta.table, "update", body, stored)
          );
        }

        return Option.map(classMetaOf(model), (concrete) =>
          validateRecord(concrete, "update", body, stored, {
            through: meta.table,
          })
        );
      },
    })
  );

/**
 * A field error as the form says it.
 *
 * @param error - The error from `recordSchema` or the server.
 * @returns The text.
 */
export const fieldErrorText = (error: FieldError): string =>
  Match.value(error).pipe(
    Match.tag("InvalidValue", ({ hint, message }) =>
      hint === undefined ? message : `${message} ${hint}`
    ),
    Match.tag("Required", () => "This field is required."),
    Match.tag("ReadOnlyField", () => "This field cannot be changed."),
    Match.tag(
      "DefinitionRetired",
      () => "This field is retired and can no longer be changed."
    ),
    Match.exhaustive
  );

/**
 * Field errors by the ID of the field they name.
 *
 * @param fields - The form's fields.
 * @param errors - Field errors, naming fields by API name.
 * @returns The texts by field ID; errors naming no field are left out.
 */
export const errorsByFieldId = (
  fields: readonly MetaField[],
  errors: readonly FieldError[]
): Readonly<Record<string, readonly string[]>> =>
  Record.fromIterableWith(
    fields.flatMap((field) => {
      const texts = errors.flatMap((fieldError) =>
        fieldError.field === field.name ? [fieldErrorText(fieldError)] : []
      );

      return texts.length === 0 ? [] : [{ id: field.id, texts }];
    }),
    ({ id, texts }) => [id, texts] as const
  );

/** What the client finds before a save. */
export interface FormCheck {
  /** The write body. */
  readonly body: FormBody;
  /** Field ID to problems: inputs that do not convert, and field errors. */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  /** Names the server would answer `UnknownField` for (none expected). */
  readonly unknownFields: readonly string[];
}

/**
 * Whether a `Required` error names a field the user cannot supply on this
 * form (`write` is `no` for the form's mode, such as a definition's owner
 * layer and state, which the server sets): the server fills it or refuses,
 * and the form does not hold the save back for it [judgment, decision
 * 0020].
 *
 * @param model - The page.
 * @param name - The field the error names.
 * @param tag - The error's tag.
 * @returns True for such a `Required` error.
 */
const isRequiredOfTheServer = (
  model: Model,
  name: string,
  tag: string
): boolean =>
  tag === "Required" &&
  fieldsOf(model).some(
    (field) =>
      field.name === name &&
      (isCreating(model) ? field.write.create : field.write.update) === "no"
  );

const joinProblems = (
  left: readonly string[],
  right: readonly string[]
): readonly string[] => [...left, ...right];

/**
 * Builds the body from the edits and judges it.
 *
 * @param model - The page.
 * @returns The body and its problems.
 */
export const checkForm = (model: Model): FormCheck => {
  const built = buildBody(editedFieldsOf(model));

  const verdict = Option.getOrElse(
    verdictOf(model, judgedBody(built.body)),
    (): RecordVerdict => ({ errors: [], invalidBody: false, unknownFields: [] })
  );

  const fieldErrors = errorsByFieldId(
    fieldsOf(model),
    verdict.errors.filter(
      (error) => !isRequiredOfTheServer(model, error.field, error._tag)
    )
  );

  const engineProblems = Option.match(metaOf(model), {
    onNone: () => ({}),
    onSome: (meta) =>
      definitionProblems(
        meta.table.name,
        fieldsOf(model),
        built.body.values,
        editedRecordOf(model)
      ),
  });

  return {
    body: built.body,
    problems: Record.union(
      Record.union(
        pipe(
          built.problems,
          Record.map((problem) => [problem])
        ),
        fieldErrors,
        joinProblems
      ),
      engineProblems,
      joinProblems
    ),
    unknownFields: verdict.unknownFields,
  };
};

/**
 * Whether a body changes nothing.
 *
 * @param body - The body.
 * @returns True when it holds no value and no secret.
 */
export const isEmptyBody = (body: FormBody): boolean =>
  Record.isEmptyRecord(body.values) && Record.isEmptyRecord(body.secrets);
