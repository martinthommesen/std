/**
 * What the form page derives from its Model, for `update` and `view`
 * alike: the fields, each field's input and base value, the write body,
 * and the problems the client finds with it (Contracts 6.3: the same
 * verdict as the server's for every field both see).
 */
import { Combobox, DatePicker } from "@foldkit/ui";
import { evaluateFormConditionInBrowser } from "@std/conditions/browser";
import type { FieldError } from "@std/definitions/field-errors";
import { validateRecord } from "@std/definitions/record-schema";
import type { RecordVerdict } from "@std/definitions/record-schema";
import type { MetaFormRule } from "@std/definitions/table-metadata";
import type { JsonValue } from "@std/values/json-value";
// oxlint-disable-next-line sonarjs/no-built-in-override -- Foldkit requires Effect module names; this module does not use the global Array.
import { Array, Match, Option, Predicate, Record, Result, pipe } from "effect";
import { groupBy } from "effect/Array";
import { AsyncData } from "foldkit";

import {
  definitionProblems,
  withRecordLimits,
} from "../../domain/definition-limits.ts";
import type { FieldShow } from "../../domain/form-fields.ts";
import { fieldShowOf, formFieldsOf } from "../../domain/form-fields.ts";
import {
  FieldInput,
  buildBody,
  createBaseValue,
  inputJson,
  inputOfValue,
  judgedBody,
  sameJson,
} from "../../domain/form-input.ts";
import type { BodyField, FormBody } from "../../domain/form-input.ts";
import type { MetaField, MetaTable } from "../../domain/metadata.ts";
import type { RecordJson } from "../../domain/record.ts";
import { tableClassView } from "../../domain/table-view.ts";
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
export const schemaFieldsOf = (model: Model): readonly MetaField[] =>
  Option.match(metaOf(model), {
    onNone: () => [],
    onSome: (meta) =>
      withRecordLimits(
        meta.table.name,
        formFieldsOf(meta.table, classMetaOf(model)),
        editedRecordOf(model)
      ),
  });

const formTableOf = (model: Model): Option.Option<MetaTable> =>
  Option.orElse(classMetaOf(model), () =>
    Option.map(metaOf(model), (meta) => meta.table)
  );

/**
 * The concrete form rules, with caller-simplified conditions.
 * @param model - The record form.
 * @returns The caller-visible form description.
 */
export const rulesOfForm = (model: Model): readonly MetaFormRule[] =>
  Option.match(formTableOf(model), {
    onNone: () => [],
    onSome: (table) => table.formRules,
  });

/** Whether the caller has a form to edit, independently of form-only restrictions.
 * @param model - The form.
 * @returns Whether at least one readable field can be edited.
 */
export const hasEditableSchema = (model: Model): boolean =>
  schemaFieldsOf(model).some(
    (field) => fieldShowOf(field, editedRecordOf(model))._tag === "Editable"
  );

/**
 * Forms with rules wait for the verdict of their exact proposal.
 * @param model - The record form.
 * @returns Whether the form must wait for an authoritative verdict.
 */
export const isFormStatePending = (model: Model): boolean =>
  hasEditableSchema(model) &&
  rulesOfForm(model).length !== 0 &&
  !AsyncData.isSuccess(model.formState);

interface LocalFieldState {
  readonly hidden: boolean;
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly choices: readonly string[] | null;
  readonly pending: boolean;
}

const localFormStates = (
  model: Model
): Readonly<Record<string, LocalFieldState>> => {
  const table = formTableOf(model);

  if (Option.isNone(table)) {
    return {};
  }

  const view = tableClassView(new Map([[table.value.name, table.value]]));
  const initial: Readonly<Record<string, LocalFieldState>> = {};

  return Array.reduce(rulesOfForm(model), initial, (states, rule) => {
    // Derive targets are not metadata. Before the server's proposal, all image data is unavailable.
    const verdict = evaluateFormConditionInBrowser(rule.condition, {
      classId: table.value.name,
      source: { record: {} },
      view,
    });

    if (verdict === false) {
      return states;
    }

    const state = states[rule.fieldId] ?? {
      choices: null,
      hidden: false,
      pending: false,
      readOnly: false,
      required: false,
    };

    const assignment =
      rule.property === "choices"
        ? {
            choices:
              verdict === true && !Predicate.isBoolean(rule.value)
                ? rule.value
                : null,
          }
        : { [rule.property]: verdict === true && rule.value === true };

    return Record.set(states, rule.fieldId, {
      ...state,
      ...assignment,
      pending: state.pending || verdict === "unknown",
    });
  });
};

/** Fields whose state needs the server's first verdict.
 * @param model - The form.
 * @returns Pending field IDs, computed once for a view.
 */
export const pendingFormFields = (model: Model): ReadonlySet<string> =>
  hasEditableSchema(model) && !AsyncData.hasData(model.formState)
    ? new Set(
        Object.entries(localFormStates(model)).flatMap(([id, state]) =>
          state.pending ? [id] : []
        )
      )
    : new Set();

const choicesUnderRule = (
  field: MetaField,
  keys: readonly string[] | null | undefined
): MetaField["choices"] => {
  if (keys === undefined || keys === null) {
    return field.choices;
  }

  const allowed = new Set(keys);

  return field.choices?.filter((choice) => allowed.has(choice.key)) ?? null;
};

/**
 * Effective form fields, with schema restrictions kept and hidden fields omitted.
 * @param model - The record form.
 * @returns The caller-visible form description.
 */
export const fieldsOf = (model: Model): readonly MetaField[] => {
  const maybeVerdict = AsyncData.getData(model.formState);

  const localStates = Option.isNone(maybeVerdict) ? localFormStates(model) : {};

  return schemaFieldsOf(model).flatMap((field) => {
    const state = Option.match(maybeVerdict, {
      onNone: () => null,
      onSome: (verdict) => verdict.fields[field.name] ?? null,
    });

    // Every readable field has a state. An absent state means the proposed image withholds it.
    const withheld = Option.isSome(maybeVerdict) && state === null;

    const local = localStates[field.id];
    const localReadOnly = withheld || (local?.readOnly ?? false);
    const localRequired = local?.required ?? false;

    const choices = choicesUnderRule(
      field,
      state === null ? local?.choices : state.choices
    );

    const hidden = state?.hidden ?? local?.hidden === true;

    return hidden
      ? []
      : [
          {
            ...field,
            choices,
            readOnly: field.readOnly || (state?.readOnly ?? localReadOnly),
            required: field.required || (state?.required ?? localRequired),
          },
        ];
  });
};

/** Whether an existing record offers no editable field under its current verdict.
 * @param model - The record form.
 * @returns Whether the page is a read-only record view.
 */
export const isReadOnlyForm = (model: Model): boolean =>
  !isCreating(model) &&
  isReady(model) &&
  fieldsOf(model).every(
    (field) => fieldShowOf(field, editedRecordOf(model))._tag !== "Editable"
  );

/**
 * Read-only values show the derived proposal; editable values stay under the user's control.
 * @param model - The record form.
 * @param field - The field metadata.
 * @returns The caller-visible form description.
 */
export const showOfField = (model: Model, field: MetaField): FieldShow => {
  const show = fieldShowOf(field, editedRecordOf(model));
  const maybeVerdict = AsyncData.getData(model.formState);

  if (
    Option.exists(
      maybeVerdict,
      (verdict) => !Object.hasOwn(verdict.fields, field.name)
    )
  ) {
    return { _tag: "Restricted" };
  }

  if (show._tag !== "ReadOnly" || Option.isNone(maybeVerdict)) {
    return show;
  }

  return Object.hasOwn(maybeVerdict.value.values, field.name)
    ? { _tag: "ReadOnly", value: maybeVerdict.value.values[field.name] ?? null }
    : show;
};

/**
 * A field by ID, as the form describes it.
 *
 * @param model - The page.
 * @param fieldId - The field's ID.
 * @returns The matching visible field, when present.
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
const baseValueOf = (model: Model, field: MetaField): JsonValue =>
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
 * A field's input: the user's edit, else the authoritative proposal, else its base value.
 *
 * @param model - The page.
 * @param field - The field.
 * @returns The input.
 */
export const inputOf = (model: Model, field: MetaField): FieldInput =>
  Option.getOrElse(Record.get(model.edits, field.id), () => {
    const base = baseValueOf(model, field);

    const proposed = Option.match(AsyncData.getData(model.formState), {
      onNone: () => base,
      onSome: (verdict) =>
        Object.hasOwn(verdict.values, field.name)
          ? (verdict.values[field.name] ?? null)
          : base,
    });

    return inputOfValue(
      field,
      proposed,
      sameJson(base, proposed) ? storedLabelOf(model, field) : Option.none()
    );
  });

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
 * @param shown - The already projected fields, when the caller has them.
 * @returns Each with its input and base value.
 */
export const editedFieldsOf = (
  model: Model,
  shown: readonly MetaField[] = fieldsOf(model)
): readonly BodyField[] => {
  const maybeRecord = editedRecordOf(model);

  const visible = new Set(shown.map((field) => field.id));

  const automatic = new Set(model.automaticClears);

  const cleared = schemaFieldsOf(model).filter(
    (field) => !visible.has(field.id) && automatic.has(field.id)
  );

  return [...shown, ...cleared].flatMap((field) =>
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
const verdictOf = (
  model: Model,
  body: Readonly<Record<string, JsonValue>>
): Option.Option<RecordVerdict> =>
  Option.flatMap(metaOf(model), (meta) =>
    Option.match(editedRecordOf(model), {
      onNone: () => Option.some(validateRecord(meta.table, "create", body)),
      onSome: (record) => {
        if (record.class === meta.table.resourceType) {
          return Option.some(
            validateRecord(meta.table, "update", body, {
              class: meta.table.name,
              values: record.values,
            })
          );
        }

        return Option.map(classMetaOf(model), (concrete) =>
          validateRecord(
            concrete,
            "update",
            body,
            { class: concrete.name, values: record.values },
            { through: meta.table }
          )
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
const fieldErrorText = (error: FieldError): string =>
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
): Readonly<Record<string, readonly string[]>> => {
  const byField = groupBy(errors, (fieldError) => fieldError.field);

  return Record.fromIterableWith(
    fields.flatMap((field) => {
      const texts = (byField[field.name] ?? []).map(fieldErrorText);

      return texts.length === 0 ? [] : [{ id: field.id, texts }];
    }),
    ({ id, texts }) => [id, texts] as const
  );
};

/** What the client finds before a save. */
export interface FormCheck {
  /** The write body. */
  readonly body: FormBody;
  /** Field ID to problems: inputs that do not convert, and field errors. */
  readonly problems: Readonly<Record<string, readonly string[]>>;
  /** Names the server would answer `UnknownField` for (none expected). */
  readonly unknownFields: readonly string[];
}

const joinProblems = (
  left: readonly string[],
  right: readonly string[]
): readonly string[] => [...left, ...right];

const requiredFormErrors = (
  model: Model,
  field: MetaField,
  schemaRequired: boolean
): readonly FieldError[] => {
  const editable =
    fieldShowOf(field, editedRecordOf(model))._tag === "Editable";

  if (!field.required || schemaRequired || !editable) {
    return [];
  }

  const canonical = pipe(
    AsyncData.getData(model.formState),
    Option.filter(() => AsyncData.isSuccess(model.formState)),
    Option.filter((verdict) => Object.hasOwn(verdict.values, field.name))
  );

  if (Option.isSome(canonical)) {
    return canonical.value.values[field.name] === null
      ? [{ _tag: "Required", field: field.name }]
      : [];
  }

  const json = inputJson(field, inputOf(model, field));

  if (Result.isFailure(json) || json.success !== null) {
    return [];
  }

  return [{ _tag: "Required", field: field.name }];
};

const choiceFormErrors = (
  model: Model,
  field: MetaField
): readonly FieldError[] => {
  const allowed = Option.flatMap(
    AsyncData.getData(model.formState),
    (verdict) => Option.fromNullishOr(verdict.fields[field.name]?.choices)
  );

  if (Option.isNone(allowed)) {
    return [];
  }

  const input = inputOf(model, field);

  if (!FieldInput.guards.Choice(input) || input.key === "") {
    return [];
  }

  return allowed.value.includes(input.key)
    ? []
    : [
        {
          _tag: "InvalidValue",
          field: field.name,
          message: "Choose one of the choices offered by this form.",
          reason: "unknownChoice",
        },
      ];
};

/**
 * Builds the body from the edits and judges it.
 *
 * @param model - The page.
 * @returns The body and its problems.
 */
export const checkForm = (model: Model): FormCheck => {
  const shown = fieldsOf(model);
  const built = buildBody(editedFieldsOf(model, shown));
  const schemaFields = schemaFieldsOf(model);
  const creating = isCreating(model);

  const serverRequired = new Set(
    shown.flatMap((field) => {
      const writeMode = creating ? field.write.create : field.write.update;

      return writeMode === "no" ? [field.name] : [];
    })
  );

  const active = new Set(
    schemaFields.flatMap((field) =>
      field.state === "active" ? [field.name] : []
    )
  );

  // A verdict may include a retired field omitted by the reread; it is not a supplied edit.
  const canonical = Option.match(AsyncData.getData(model.formState), {
    onNone: () => ({}),
    onSome: (verdict) =>
      Record.filter<string, JsonValue>((_value, name) => active.has(name))(
        verdict.values
      ),
  });

  const bodyValues = judgedBody(built.body);

  const validationValues = AsyncData.isSuccess(model.formState)
    ? { ...bodyValues, ...canonical }
    : { ...canonical, ...bodyValues };

  const verdict = Option.getOrElse(
    verdictOf(model, validationValues),
    (): RecordVerdict => ({ errors: [], invalidBody: false, unknownFields: [] })
  );

  const fieldErrors = errorsByFieldId(
    shown,
    verdict.errors.filter(
      (error) => error._tag !== "Required" || !serverRequired.has(error.field)
    )
  );

  const schemaRequired = new Set(
    schemaFields.flatMap((field) => (field.required ? [field.id] : []))
  );

  const formProblems = errorsByFieldId(
    shown,
    shown.flatMap((field) => [
      ...requiredFormErrors(model, field, schemaRequired.has(field.id)),
      ...choiceFormErrors(model, field),
    ])
  );

  const engineProblems = Option.match(metaOf(model), {
    onNone: () => ({}),
    onSome: (meta) =>
      definitionProblems(
        meta.table.name,
        shown,
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
      Record.union(engineProblems, formProblems, joinProblems),
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

/**
 * Whether the form holds edits leaving would lose: of the effective edits
 * (hidden and read-only fields left out, automatic clears kept), one a save
 * would send (it differs from the stored value), or one that does not
 * convert yet, such as incomplete JSON or a number with a letter in it,
 * which a save cannot send but the user typed. A read-only form never has
 * any.
 *
 * @param model - The page.
 * @returns True when leaving would lose them.
 */
export const hasUnsavedEdits = (model: Model): boolean => {
  if (isReadOnlyForm(model)) {
    return false;
  }

  const built = buildBody(editedFieldsOf(model));

  return !isEmptyBody(built.body) || !Record.isEmptyRecord(built.problems);
};
