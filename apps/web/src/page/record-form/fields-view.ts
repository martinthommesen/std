/**
 * One field of a record's form: its label, required marker, help text and
 * problems, and the control its type takes (Contracts 6.5) — or, for a
 * field the user cannot change, its value as text, "Restricted" for a
 * withheld field and "Not delivered" for an absent one (6.6).
 *
 * Controls are Foldkit UI: Input (text, numbers as their canonical text,
 * UUIDs, the time of a date-time), Textarea (long text, json and condition
 * fields as JSON), Checkbox (booleans), Select (choices: labels shown, keys
 * sent), Date Picker (dates and date-times) and Combobox (references).
 * Password and secret inputs are uncontrolled and never show a value: the
 * Model holds what the user typed only as `Redacted`.
 */
import { Checkbox, Input, Select, Textarea } from "@foldkit/ui";
import type { MetaChoice, MetaField } from "@std/definitions/table-metadata";
import type { JsonValue } from "@std/values/json-value";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { Match, Option, Record, pipe } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { childAttributes } from "foldkit/html";

import { fieldShowOf } from "../../domain/form-fields.ts";
import type { FieldShow } from "../../domain/form-fields.ts";
import {
  FieldInput,
  sameJson,
  toWriteOnlyValue,
} from "../../domain/form-input.ts";
import { changeText, droppedText } from "../../domain/stale-edits.ts";
import { valueText } from "../../domain/value-text.ts";
import { calendarDateOf } from "../../filter-builder/condition.ts";
import { buttonView } from "../../view/controls.ts";
import { datePickerField } from "../../view/date-picker.ts";
import {
  checkForm,
  controlIdOf,
  editedRecordOf,
  inputOf,
  isCreating,
  storedLabelOf,
} from "./form.ts";
import { Message } from "./message.ts";
import type { Model, Picker } from "./model.ts";
import { ReferenceCombobox, restingLabelOf } from "./update.ts";

const RESTRICTED_TEXT = "Restricted";

const RESTRICTED_LABEL = "Restricted: you are not allowed to read this value";

const AUTO_NUMBER_HINT = "Assigned when the record is saved.";

const LABEL_CLASS = "control-label";

const INPUT_CLASS = "control-input";

const CONTROL_CLASS = "control form-field";

/** What the view shows around one field. */
interface FieldNotes {
  readonly problems: readonly string[];
  readonly hints: readonly string[];
}

const descriptionIdOf = (controlId: string): string =>
  `${controlId}-description`;

const labelIdOf = (field: MetaField): string => `field-${field.id}-label`;

const labelText = (field: MetaField, isEditable: boolean): string =>
  isEditable && field.required ? `${field.label} (required)` : field.label;

const valueOfJson = (
  model: Model,
  field: MetaField,
  value: JsonValue
): string =>
  valueText(field.type, value, {
    choices: field.choices,
    maybeLabel: storedLabelOf(model, field),
  });

const notesView = (
  controlId: string,
  notes: FieldNotes,
  h: HtmlBuilder<Message>
): Html =>
  // NOTE: the region stays mounted, so a problem that appears in it is
  // announced even when focus does not move.
  h.div(
    [h.Id(descriptionIdOf(controlId)), h.AriaLive("polite")],
    [
      ...notes.hints.map((hint) =>
        h.keyed("p")(hint, [h.Class("control-hint")], [hint])
      ),
      ...notes.problems.map((problem) =>
        h.keyed("p")(problem, [h.Class("field-error")], [problem])
      ),
    ]
  );

const hasNotes = (notes: FieldNotes): boolean =>
  notes.hints.length > 0 || notes.problems.length > 0;

// READ-ONLY

const readOnlyText = (
  model: Model,
  field: MetaField,
  value: JsonValue
): string => {
  if (value === null) {
    return field.autoNumber !== null && isCreating(model)
      ? AUTO_NUMBER_HINT
      : "Empty";
  }

  return valueOfJson(model, field, value);
};

const shownValueView = (
  field: MetaField,
  state: string,
  content: readonly Html[],
  notes: FieldNotes,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("form-field"), h.DataAttribute("field-state", state)],
    [
      h.span([h.Id(labelIdOf(field)), h.Class(LABEL_CLASS)], [field.label]),
      h.div(
        [
          h.Role("group"),
          h.Class("form-value"),
          h.AriaLabelledBy(labelIdOf(field)),
          ...(hasNotes(notes)
            ? [h.AriaDescribedBy(descriptionIdOf(`field-${field.id}`))]
            : []),
        ],
        content
      ),
      notesView(`field-${field.id}`, notes, h),
    ]
  );

const restrictedView = (
  field: MetaField,
  notes: FieldNotes,
  h: HtmlBuilder<Message>
): Html =>
  shownValueView(
    field,
    "restricted",
    [
      h.span(
        [h.Class("cell-restricted"), h.Title(RESTRICTED_LABEL)],
        [
          h.span([h.AriaHidden(true)], [RESTRICTED_TEXT]),
          h.span([h.Class("visually-hidden")], [RESTRICTED_LABEL]),
        ]
      ),
    ],
    notes,
    h
  );

// CONTROLS

interface ControlConfig {
  readonly field: MetaField;
  readonly controlId: string;
  readonly notes: FieldNotes;
  readonly isInvalid: boolean;
}

const requiredAttributes = (
  field: MetaField,
  h: HtmlBuilder<Message>
): readonly Attribute<Message>[] =>
  field.required ? [h.AriaRequired(true)] : [];

const NUMERIC_KINDS: ReadonlySet<string> = new Set([
  "integer",
  "bigInteger",
  "decimal",
]);

const textControl = (
  config: ControlConfig,
  text: string,
  h: HtmlBuilder<Message>
): Html =>
  Input.view(
    {
      hasDescription: hasNotes(config.notes),
      id: config.controlId,
      isInvalid: config.isInvalid,
      onInput: (typed) =>
        Message.UpdatedText({ fieldId: config.field.id, text: typed }),
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [labelText(config.field, true)]
            ),
            h.input([
              ...attributes.input,
              ...requiredAttributes(config.field, h),
              ...(NUMERIC_KINDS.has(config.field.type.kind)
                ? [h.InputMode("decimal")]
                : []),
              h.Spellcheck(false),
              h.Class(INPUT_CLASS),
            ]),
            notesView(config.controlId, config.notes, h),
          ]
        ),
      type: "text",
      value: text,
    },
    h
  );

const LONG_TEXT_ROWS = 5;

const textareaControl = (
  config: ControlConfig,
  text: string,
  h: HtmlBuilder<Message>
): Html =>
  Textarea.view(
    {
      hasDescription: hasNotes(config.notes),
      id: config.controlId,
      isInvalid: config.isInvalid,
      onInput: (typed) =>
        Message.UpdatedText({ fieldId: config.field.id, text: typed }),
      rows: LONG_TEXT_ROWS,
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [labelText(config.field, true)]
            ),
            h.textarea([
              ...attributes.textarea,
              ...(config.field.required ? [h.AriaRequired(true)] : []),
              h.Spellcheck(config.field.type.kind === "longText"),
              h.Class(INPUT_CLASS),
            ]),
            notesView(config.controlId, config.notes, h),
          ]
        ),
      value: text,
    },
    h
  );

const checkboxControl = (
  config: ControlConfig,
  isChecked: boolean,
  h: HtmlBuilder<Message>
): Html =>
  Checkbox.view(
    {
      hasDescription: hasNotes(config.notes),
      id: config.controlId,
      isChecked,
      onToggle: (checked) =>
        Message.ToggledFlag({ fieldId: config.field.id, isChecked: checked }),
      toView: (attributes) =>
        h.div(
          [h.Class("control control-inline form-field")],
          [
            h.button(
              [
                ...attributes.checkbox,
                h.Id(config.controlId),
                h.Class("checkbox"),
              ],
              isChecked ? ["✓"] : []
            ),
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [config.field.label]
            ),
            notesView(config.controlId, config.notes, h),
          ]
        ),
    },
    h
  );

/**
 * The options of a choice field: empty, then the active choices in order;
 * a hidden (retired) choice, or a key no longer offered, only when it is
 * the stored value (an unchanged hidden key is kept, Contracts 6.5) or the
 * user's own choice that the definitions took away after it was made (the
 * client's verdict then flags it, decision 0020).
 *
 * @param field - The choice field.
 * @param storedKey - The stored key, `""` for none.
 * @param chosenKey - The key the input holds, `""` for none.
 * @returns The options.
 */
export const choiceOptionsOf = (
  field: MetaField,
  storedKey: string,
  chosenKey = storedKey
): readonly { readonly value: string; readonly label: string }[] => {
  const choices: readonly MetaChoice[] = field.choices ?? [];
  const kept = new Set([storedKey, chosenKey]);

  const active = choices
    .filter((choice) => !choice.retired || kept.has(choice.key))
    .toSorted((left, right) => left.order - right.order)
    .map((choice) => ({
      label: choice.retired ? `${choice.label} (retired)` : choice.label,
      value: choice.key,
    }));

  const unknown = [...kept].filter(
    (key) => key !== "" && !choices.some((choice) => choice.key === key)
  );

  return [
    { label: "None", value: "" },
    ...active,
    ...unknown.map((key) => ({
      label: `${key} (no longer offered)`,
      value: key,
    })),
  ];
};

const storedKeyOf = (model: Model, field: MetaField): string =>
  Option.match(editedRecordOf(model), {
    onNone: () => "",
    onSome: (record) => {
      const value = record.values[field.name];

      return value !== undefined && isJsonString(value) ? value : "";
    },
  });

const selectControl = (
  model: Model,
  config: ControlConfig,
  key: string,
  h: HtmlBuilder<Message>
): Html =>
  Select.view(
    {
      hasDescription: hasNotes(config.notes),
      id: config.controlId,
      isInvalid: config.isInvalid,
      onChange: (chosen) =>
        Message.SelectedChoice({ fieldId: config.field.id, key: chosen }),
      toView: (attributes) =>
        h.div(
          [h.Class(CONTROL_CLASS)],
          [
            h.label(
              [...attributes.label, h.Class(LABEL_CLASS)],
              [labelText(config.field, true)]
            ),
            h.select(
              [
                ...attributes.select,
                ...requiredAttributes(config.field, h),
                h.Class(INPUT_CLASS),
              ],
              choiceOptionsOf(
                config.field,
                storedKeyOf(model, config.field),
                key
              ).map((option) =>
                h.option(
                  [h.Value(option.value), h.Selected(option.value === key)],
                  [option.label]
                )
              )
            ),
            notesView(config.controlId, config.notes, h),
          ]
        ),
      value: key,
    },
    h
  );

/**
 * What ties a control that is not the field's main input (a Date
 * Picker's trigger, a date-time's time) to the field's notes: its
 * description, `aria-invalid` with a problem, and `aria-required`.
 *
 * @param config - The field's control.
 * @param h - The builder.
 * @returns The attributes.
 */
const describedControlAttributes = (
  config: ControlConfig,
  h: HtmlBuilder<Message>
): readonly Attribute<Message>[] => [
  ...(hasNotes(config.notes)
    ? [h.AriaDescribedBy(descriptionIdOf(config.controlId))]
    : []),
  ...(config.isInvalid ? [h.AriaInvalid(true)] : []),
  ...requiredAttributes(config.field, h),
];

const dateControl = (
  model: Model,
  config: ControlConfig,
  maybeDate: Option.Option<string>,
  h: HtmlBuilder<Message>
): Html =>
  Option.match(Record.get(model.datePickers, config.field.id), {
    onNone: () => h.empty,
    onSome: (picker) =>
      h.div(
        [h.Class("form-field form-date")],
        [
          datePickerField(
            {
              label: labelText(config.field, true),
              maybeSelectedDate: pipe(
                maybeDate,
                Option.flatMap(calendarDateOf)
              ),
              model: picker,
              toParentMessage: (message) =>
                Message.GotDatePickerMessage({
                  fieldId: config.field.id,
                  message,
                }),
              triggerAttributes: childAttributes(
                describedControlAttributes(config, h)
              ),
            },
            h
          ),
          Option.isSome(maybeDate)
            ? buttonView(
                {
                  maybeAriaLabel: Option.some(`Clear ${config.field.label}`),
                  onClick: Message.ClickedClearDate({
                    fieldId: config.field.id,
                  }),
                  text: "Clear",
                  variant: "quiet",
                },
                h
              )
            : h.empty,
          notesView(config.controlId, config.notes, h),
        ]
      ),
  });

const timeInputIdOf = (field: MetaField): string => `field-${field.id}-time`;

const dateTimeControl = (
  model: Model,
  config: ControlConfig,
  maybeDate: Option.Option<string>,
  time: string,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("form-date-time")],
    [
      dateControl(
        model,
        {
          ...config,
          field: {
            ...config.field,
            label: `${config.field.label}, date (UTC)`,
          },
        },
        maybeDate,
        h
      ),
      Input.view(
        {
          id: timeInputIdOf(config.field),
          isInvalid: config.isInvalid,
          onInput: (typed) =>
            Message.UpdatedTime({ fieldId: config.field.id, time: typed }),
          toView: (attributes) =>
            h.div(
              [h.Class("control")],
              [
                h.label(
                  [...attributes.label, h.Class(LABEL_CLASS)],
                  [`${config.field.label}, time (UTC, HH:MM)`]
                ),
                h.input([
                  ...attributes.input,
                  ...describedControlAttributes(config, h),
                  h.Spellcheck(false),
                  h.Class("control-input control-time"),
                ]),
              ]
            ),
          type: "text",
          value: time,
        },
        h
      ),
    ]
  );

const pickerStatusText = (picker: Picker): string =>
  Match.value(picker.results).pipe(
    Match.tag("Loading", () => "Searching…"),
    Match.tag("Refreshing", () => "Searching…"),
    Match.tag(
      "Failure",
      () => "The records could not be searched. Type to try again."
    ),
    Match.tag(
      "Stale",
      () => "The records could not be searched. Type to try again."
    ),
    Match.tag("Success", ({ data }) =>
      data.length === 0 ? "No records match." : ""
    ),
    Match.tag("Idle", () => ""),
    Match.exhaustive
  );

const pickerItemsOf = (
  picker: Picker
): readonly { readonly id: string; readonly label: string }[] =>
  Match.value(picker.results).pipe(
    Match.tag("Success", "Refreshing", "Stale", ({ data }) => data),
    Match.orElse(() => [])
  );

const referenceControl = (
  model: Model,
  config: ControlConfig,
  input: FieldInput,
  h: HtmlBuilder<Message>
): Html =>
  Option.match(Record.get(model.pickers, config.field.id), {
    onNone: () => h.empty,
    onSome: (picker) => {
      const items = pickerItemsOf(picker);

      const labels = new Map(items.map((item) => [item.id, item.label]));

      const maybeSelected = FieldInput.guards.Reference(input)
        ? input.maybeId
        : Option.none();

      const status = pickerStatusText(picker);

      return h.div(
        [h.Class("control form-field form-reference")],
        [
          h.label(
            [h.For(config.controlId), h.Class(LABEL_CLASS)],
            [labelText(config.field, true)]
          ),
          h.submodel({
            model: picker.combobox,
            slotId: picker.combobox.id,
            toParentMessage: (message) =>
              Message.GotPickerMessage({ fieldId: config.field.id, message }),
            view: ReferenceCombobox.view,
            viewInputs: {
              anchor: { gap: 4, padding: 8, placement: "bottom-start" },
              attributes: childAttributes([h.Class("combobox")]),
              backdropAttributes: childAttributes([
                h.Class("combobox-backdrop"),
              ]),
              buttonAttributes: childAttributes([
                h.Class("combobox-button"),
                h.AriaLabel(`Show records for ${config.field.label}`),
              ]),
              buttonContent: h.span([h.AriaHidden(true)], ["▾"]),
              inputAttributes: childAttributes([
                h.Class(INPUT_CLASS),
                ...requiredAttributes(config.field, h),
                ...(hasNotes(config.notes) || status !== ""
                  ? [h.AriaDescribedBy(descriptionIdOf(config.controlId))]
                  : []),
              ]),
              inputPlaceholder: "Type to search",
              isInvalid: config.isInvalid,
              itemToConfig: (id, context) => ({
                className: "combobox-option",
                content: h.span(
                  context.isSelected ? [h.DataAttribute("selected", "")] : [],
                  [labels.get(id) ?? id]
                ),
              }),
              itemToDisplayText: (id) => labels.get(id) ?? id,
              itemToValue: (id) => id,
              items: items.map((item) => item.id),
              itemsAttributes: childAttributes([h.Class("combobox-options")]),
              maybeSelectedValue: maybeSelected,
              restingInputValue: restingLabelOf(input),
            },
          }),
          notesView(
            config.controlId,
            {
              ...config.notes,
              hints:
                status === ""
                  ? config.notes.hints
                  : [...config.notes.hints, status],
            },
            h
          ),
        ]
      );
    },
  });

const writeOnlyStateOf = (model: Model, field: MetaField): boolean =>
  Option.match(editedRecordOf(model), {
    onNone: () => false,
    onSome: (record) => {
      const value = record.values[field.name];

      return value !== undefined && isJsonObject(value) && value.set === true;
    },
  });

const writeOnlyStateText = (isClearing: boolean, isSet: boolean): string => {
  if (isClearing) {
    return "Set; it will be cleared when you save.";
  }

  return isSet ? "Set. Type a new value to replace it." : "Not set.";
};

const writeOnlyControl = (
  model: Model,
  config: ControlConfig,
  input: FieldInput,
  h: HtmlBuilder<Message>
): Html => {
  const { field } = config;
  const isSet = writeOnlyStateOf(model, field);

  const isClearing =
    FieldInput.guards.WriteOnly(input) &&
    Record.has(model.edits, field.id) &&
    Option.isNone(input.maybeValue);

  const hasTyped = Record.has(model.edits, field.id) && !isClearing;

  const stateText = writeOnlyStateText(isClearing, isSet);

  return h.div(
    [h.Class("form-field form-write-only")],
    [
      Input.view(
        {
          hasDescription: true,
          id: config.controlId,
          isInvalid: config.isInvalid,
          onInput: (typed) =>
            Message.UpdatedWriteOnly({
              fieldId: field.id,
              maybeValue:
                typed === ""
                  ? Option.none()
                  : Option.some(toWriteOnlyValue(typed)),
            }),
          toView: (attributes) =>
            h.div(
              [h.Class("control")],
              [
                h.label(
                  [...attributes.label, h.Class(LABEL_CLASS)],
                  [`${labelText(field, true)}: new value`]
                ),
                // NOTE: uncontrolled while the user types (no `value`), so
                // the Model's redacted copy is never rendered; set to ""
                // when there is no typed value, which empties the input
                // after a save or "Keep the stored value".
                h.input([
                  ...attributes.input,
                  ...(hasTyped ? [] : [h.Value("")]),
                  h.Autocomplete("new-password"),
                  h.Spellcheck(false),
                  h.Class(INPUT_CLASS),
                ]),
                notesView(
                  config.controlId,
                  {
                    ...config.notes,
                    hints: [stateText, ...config.notes.hints],
                  },
                  h
                ),
              ]
            ),
          type: "password",
        },
        h
      ),
      field.type.kind === "secret" && isSet && !isClearing
        ? buttonView(
            {
              maybeAriaLabel: Option.some(
                `Clear the stored value of ${field.label}`
              ),
              onClick: Message.ClickedClearSecret({ fieldId: field.id }),
              text: "Clear the stored value",
              variant: "quiet",
            },
            h
          )
        : h.empty,
      isClearing
        ? buttonView(
            {
              maybeAriaLabel: Option.some(
                `Keep the stored value of ${field.label}`
              ),
              onClick: Message.ClickedKeepSecret({ fieldId: field.id }),
              text: "Keep the stored value",
              variant: "quiet",
            },
            h
          )
        : h.empty,
    ]
  );
};

const editableView = (
  model: Model,
  config: ControlConfig,
  h: HtmlBuilder<Message>
): Html => {
  const input = inputOf(model, config.field);
  const { kind } = config.field.type;

  return Match.value(input).pipe(
    Match.tag("Text", ({ text }) =>
      kind === "longText" || kind === "json" || kind === "condition"
        ? textareaControl(config, text, h)
        : textControl(config, text, h)
    ),
    Match.tag("Flag", ({ isChecked }) => checkboxControl(config, isChecked, h)),
    Match.tag("Choice", ({ key }) => selectControl(model, config, key, h)),
    Match.tag("Day", ({ maybeDate }) =>
      dateControl(model, config, maybeDate, h)
    ),
    Match.tag("Instant", ({ maybeDate, time }) =>
      dateTimeControl(model, config, maybeDate, time, h)
    ),
    Match.tag("Reference", () => referenceControl(model, config, input, h)),
    Match.tag("WriteOnly", () => writeOnlyControl(model, config, input, h)),
    Match.exhaustive
  );
};

// NOTES

/**
 * What changed in a field's definition since the form was opened, as the
 * `SchemaChanged` refusals named it (Contracts 6.4).
 *
 * @param model - The page.
 * @param field - The field, as the form describes it now.
 * @returns The hint, if the field changed.
 */
const changedDefinitionHintOf = (
  model: Model,
  field: MetaField
): readonly string[] => {
  const texts = [
    ...new Set(
      model.staleChanges.flatMap((change) =>
        change.fieldId === field.id
          ? [changeText(change, Option.some(field))]
          : []
      )
    ),
  ];

  return texts.length === 0
    ? []
    : [`Changed since you opened this form: ${texts.join(", ")}.`];
};

const droppedHintOf = (model: Model, field: MetaField): readonly string[] =>
  model.droppedEdits.flatMap((note) =>
    note.fieldId === field.id ? [droppedText(note)] : []
  );

/**
 * After a version conflict and a reload: what someone else saved in a
 * field the user changed too, when it differs from what the user started
 * from.
 *
 * @param model - The page.
 * @param field - The field.
 * @returns The hint, if any.
 */
const conflictHintOf = (model: Model, field: MetaField): readonly string[] =>
  Option.match(Option.all([model.maybeEditsFrom, editedRecordOf(model)]), {
    onNone: () => [],
    onSome: ([before, now]) => {
      const was = before.values[field.name] ?? null;
      const is = now.values[field.name] ?? null;

      return Record.has(model.edits, field.id) && !sameJson(was, is)
        ? [
            `Someone else changed this to: ${is === null ? "Empty" : valueOfJson(model, field, is)}. Your value is kept.`,
          ]
        : [];
    },
  });

const notesOf = (
  model: Model,
  field: MetaField,
  problems: readonly string[]
): FieldNotes => ({
  hints: [
    ...(field.helpText === null ? [] : [field.helpText]),
    ...changedDefinitionHintOf(model, field),
    ...droppedHintOf(model, field),
    ...conflictHintOf(model, field),
  ],
  problems,
});

/**
 * The problems each field shows: the client's (after a save attempt) and
 * the server's (until the field is edited).
 *
 * @param model - The page.
 * @returns Problems by field ID.
 */
export const shownProblemsOf = (
  model: Model
): Readonly<Record<string, readonly string[]>> =>
  Record.union(
    model.isShowingProblems ? checkForm(model).problems : {},
    model.serverErrors,
    (client, server) => [...new Set([...client, ...server])]
  );

const fieldShowView = (
  model: Model,
  field: MetaField,
  show: FieldShow,
  problems: readonly string[],
  h: HtmlBuilder<Message>
): Html => {
  const notes = notesOf(model, field, problems);

  return Match.value(show).pipe(
    Match.tag("Editable", () =>
      editableView(
        model,
        {
          controlId: controlIdOf(field),
          field,
          isInvalid: problems.length > 0,
          notes,
        },
        h
      )
    ),
    Match.tag("ReadOnly", ({ value }) =>
      shownValueView(
        field,
        value === null ? "empty" : "value",
        [h.span([], [readOnlyText(model, field, value)])],
        notes,
        h
      )
    ),
    Match.tag("Restricted", () => restrictedView(field, notes, h)),
    Match.tag("NotDelivered", () =>
      shownValueView(
        field,
        "not-delivered",
        [h.span([], ["Not delivered"])],
        notes,
        h
      )
    ),
    Match.exhaustive
  );
};

/**
 * One field of the form.
 *
 * @param model - The page.
 * @param field - The field, as the form describes it.
 * @param problems - The problems it shows.
 * @param h - The builder.
 * @returns The field.
 */
export const fieldView = (
  model: Model,
  field: MetaField,
  problems: readonly string[],
  h: HtmlBuilder<Message>
): Html =>
  h.keyed("div")(
    field.id,
    [h.Class("form-row"), h.DataAttribute("field", field.name)],
    [
      fieldShowView(
        model,
        field,
        fieldShowOf(field, editedRecordOf(model)),
        problems,
        h
      ),
    ]
  );
