/**
 * What becomes of a form's edits when its definitions change under it
 * (plan Step 2, workstream 2C; Contracts 6.4) [judgment, decision 0020].
 *
 * Edits are kept by field ID, so a renamed field keeps its edit and the
 * next save sends it under the new name. When new metadata arrives at
 * another revision (after a `SchemaChanged` refusal, or a background
 * refresh), and again when the record is reread under it:
 *
 * - an edit of a field the form still offers a control for, whose input
 *   still fits the field's type, is **kept** in its control. If its value
 *   no longer validates (a choice no longer offered, a shorter maximum
 *   length, a field now required), the client's verdict flags it on the
 *   field and blocks the save until the user fixes it: the user's work is
 *   never thrown away while it can still be saved;
 * - an edit the form can no longer send is **dropped**, with a note naming
 *   the field, why, and what the user had entered (never a password or
 *   secret), so they can carry it elsewhere: the field was removed or is
 *   no longer readable (`Removed`), retired (`Retired`), became read-only
 *   or not writable for the caller (`ReadOnly`), changed to a type the
 *   input no longer fits (`TypeChanged`), or the reread record withholds
 *   it (`Restricted`) or no longer delivers it (`NotDelivered`).
 *
 * Nothing here sends anything: the user saves again (Contracts 6.4).
 */
import type { SchemaChange } from "@std/api/errors/schemas";
import { Match, Option, Record, Schema, pipe } from "effect";

import type { FieldShow } from "./form-fields.ts";
import { isWritable } from "./form-fields.ts";
import { inputOfValue } from "./form-input.ts";
import type { FieldInput } from "./form-input.ts";
import type { MetaField } from "./metadata.ts";
import { valueText } from "./value-text.ts";

/** Why an edit was dropped. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const DroppedReason = Schema.Literals([
  "Removed",
  "Retired",
  "ReadOnly",
  "TypeChanged",
  "Restricted",
  "NotDelivered",
  "FormRule",
]);

/** Why an edit was dropped. */
export type DroppedReason = typeof DroppedReason.Type;

/**
 * An edit the form dropped: the field's ID and label (as the user last saw
 * it), why, and the entered value as text (none for a password or secret,
 * and none for an emptied field).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const DroppedEdit = Schema.Struct({
  fieldId: Schema.String,
  label: Schema.String,
  maybeText: Schema.Option(Schema.String),
  reason: DroppedReason,
});

/** An edit the form dropped. */
export type DroppedEdit = typeof DroppedEdit.Type;

/** The edits by field ID. */
type Edits = Readonly<Record<string, FieldInput>>;

/** What reconciling edits found. */
export interface Reconciled {
  readonly edits: Edits;
  readonly dropped: readonly DroppedEdit[];
}

const nonEmpty = (text: string): Option.Option<string> =>
  text.trim() === "" ? Option.none() : Option.some(text);

/**
 * An input as text the user can read back, as a note shows it.
 *
 * @param field - The field the input was made for.
 * @param input - The input.
 * @returns The text; none for a password or secret, or an empty input.
 */
export const inputText = (
  field: MetaField,
  input: FieldInput
): Option.Option<string> =>
  Match.value(input).pipe(
    Match.withReturnType<Option.Option<string>>(),
    Match.tag("Text", ({ text }) => nonEmpty(text)),
    Match.tag("Choice", ({ key }) =>
      key === ""
        ? Option.none()
        : Option.some(
            valueText(field.type, key, {
              choices: field.choices,
              maybeLabel: Option.none(),
            })
          )
    ),
    Match.tag("Flag", ({ isChecked }) => Option.some(isChecked ? "Yes" : "No")),
    Match.tag("Day", ({ maybeDate }) => maybeDate),
    Match.tag("Instant", ({ maybeDate, time }) =>
      pipe(
        maybeDate,
        Option.map((date) =>
          time.trim() === "" ? `${date} UTC` : `${date} ${time.trim()} UTC`
        )
      )
    ),
    Match.tag("Reference", ({ maybeId, maybeLabel }) =>
      Option.orElse(maybeLabel, () => maybeId)
    ),
    Match.tag("WriteOnly", () => Option.none()),
    Match.exhaustive
  );

/**
 * Whether an input fits a field's type: the input a stored value of the
 * field would get has the same shape.
 *
 * @param field - The field.
 * @param input - The input.
 * @returns True when the input can stay in the field's control.
 */
export const inputFits = (field: MetaField, input: FieldInput): boolean =>
  inputOfValue(field, null, Option.none())._tag === input._tag;

const dropped = (
  field: MetaField,
  input: FieldInput,
  reason: DroppedReason
): DroppedEdit => ({
  fieldId: field.id,
  label: field.label,
  maybeText: inputText(field, input),
  reason,
});

const reconcile = (
  edits: Edits,
  decide: (fieldId: string, input: FieldInput) => Option.Option<DroppedEdit>
): Reconciled => {
  const outcomes = Record.toEntries(edits).map(([fieldId, input]) => ({
    drop: decide(fieldId, input),
    fieldId,
    input,
  }));

  return {
    dropped: outcomes.flatMap((outcome) => Option.toArray(outcome.drop)),
    edits: Object.fromEntries(
      outcomes.flatMap((outcome) =>
        Option.isNone(outcome.drop) ? [[outcome.fieldId, outcome.input]] : []
      )
    ),
  };
};

/**
 * Splits the edits by what new metadata allows (decision 0020): kept, or
 * dropped with a note. Run when the form's metadata arrives at another
 * revision.
 *
 * @param edits - The edits by field ID.
 * @param before - The fields the edits were made with.
 * @param after - The fields of the new metadata.
 * @param isCreate - Whether the form creates a record.
 * @returns The edits kept and the notes of those dropped.
 */
export const reconcileWithMetadata = (
  edits: Edits,
  before: readonly MetaField[],
  after: readonly MetaField[],
  isCreate: boolean
): Reconciled =>
  reconcile(edits, (fieldId, input) => {
    const old = before.find((field) => field.id === fieldId);
    const now = after.find((field) => field.id === fieldId);

    if (now === undefined) {
      return Option.some({
        fieldId,
        label: old?.label ?? fieldId,
        maybeText: old === undefined ? Option.none() : inputText(old, input),
        reason: "Removed",
      });
    }

    const described = old ?? now;

    if (now.state === "retired") {
      return Option.some(dropped(described, input, "Retired"));
    }

    if (!isWritable(now, isCreate)) {
      return Option.some(dropped(described, input, "ReadOnly"));
    }

    return inputFits(now, input)
      ? Option.none()
      : Option.some(dropped(described, input, "TypeChanged"));
  });

/**
 * Splits the edits by how the reread record shows each field: a field it
 * withholds or no longer delivers has no control, so its edit is dropped
 * with a note. Run when the record is reread under edits.
 *
 * @param edits - The edits by field ID.
 * @param fields - The form's fields.
 * @param showOf - How the reread record shows a field.
 * @returns The edits kept and the notes of those dropped.
 */
export const reconcileWithRecord = (
  edits: Edits,
  fields: readonly MetaField[],
  showOf: (field: MetaField) => FieldShow
): Reconciled =>
  reconcile(edits, (fieldId, input) => {
    const field = fields.find((candidate) => candidate.id === fieldId);

    if (field === undefined) {
      return Option.none();
    }

    return Match.value(showOf(field)).pipe(
      Match.withReturnType<Option.Option<DroppedEdit>>(),
      Match.tag("Restricted", () =>
        Option.some(dropped(field, input, "Restricted"))
      ),
      Match.tag("NotDelivered", () =>
        Option.some(dropped(field, input, "NotDelivered"))
      ),
      Match.tag("ReadOnly", () =>
        Option.some(dropped(field, input, "ReadOnly"))
      ),
      Match.tag("Editable", () => Option.none()),
      Match.exhaustive
    );
  });

/**
 * Notes of dropped edits, the newest replacing an older one of the same
 * field.
 *
 * @param older - The notes so far.
 * @param newer - The new notes.
 * @returns Both, one per field.
 */
export const mergeDropped = (
  older: readonly DroppedEdit[],
  newer: readonly DroppedEdit[]
): readonly DroppedEdit[] => [
  ...older.filter(
    (note) => !newer.some((replacing) => replacing.fieldId === note.fieldId)
  ),
  ...newer,
];

const changeKeyOf = (change: SchemaChange): string =>
  `${change.table}/${change.fieldId ?? ""}/${change.kind}`;

/**
 * Changes of `SchemaChanged` refusals, without repeats: a later refusal
 * adds its changes to those still marked.
 *
 * @param older - The changes marked so far.
 * @param newer - The refusal's changes.
 * @returns Both, each (table, field, kind) once.
 */
export const mergeChanges = (
  older: readonly SchemaChange[],
  newer: readonly SchemaChange[]
): readonly SchemaChange[] => {
  const newKeys = new Set(newer.map(changeKeyOf));

  return [
    ...older.filter((change) => !newKeys.has(changeKeyOf(change))),
    ...newer,
  ];
};

/**
 * How the form says one change, for a field it still shows (decision
 * 0020).
 *
 * @param change - The change.
 * @param maybeField - The field as the new metadata describes it.
 * @returns The words, such as "renamed" or "now required".
 */
export const changeText = (
  change: SchemaChange,
  maybeField: Option.Option<MetaField>
): string =>
  Match.value(change.kind).pipe(
    Match.when("fieldAdded", () => "added"),
    Match.when("fieldRenamed", () => "renamed"),
    Match.when("fieldRetired", () => "retired"),
    Match.when("fieldPurged", () => "removed"),
    Match.when("typeChanged", () => "its type changed"),
    Match.when("settingsChanged", () => "its settings changed"),
    Match.when("choicesChanged", () => "its choices changed"),
    Match.when("requiredChanged", () =>
      Option.exists(maybeField, (field) => field.required)
        ? "now required"
        : "no longer required"
    ),
    Match.when("readOnlyChanged", () =>
      Option.exists(maybeField, (field) => field.readOnly)
        ? "now read-only"
        : "no longer read-only"
    ),
    Match.when("tableRetired", () => "the table was retired"),
    Match.when("unknown", () => "may have changed"),
    Match.exhaustive
  );

/**
 * Why a note says an edit was dropped.
 *
 * @param reason - The reason.
 * @returns The words.
 */
export const droppedReasonText = (reason: DroppedReason): string =>
  Match.value(reason).pipe(
    Match.when("FormRule", () => "a form rule hid or locked this field"),
    Match.when("Removed", () => "the field is no longer available to you"),
    Match.when("Retired", () => "the field was retired"),
    Match.when("ReadOnly", () => "you can no longer change this field"),
    Match.when("TypeChanged", () => "the field's type changed"),
    Match.when("Restricted", () => "you are no longer allowed to read it"),
    Match.when("NotDelivered", () => "the record no longer delivers it"),
    Match.exhaustive
  );

/**
 * A dropped edit's note, as the form says it.
 *
 * @param note - The dropped edit.
 * @returns The sentence.
 */
export const droppedText = (note: DroppedEdit): string =>
  `Your change to ${note.label} was not kept: ${droppedReasonText(note.reason)}.${Option.match(
    note.maybeText,
    {
      onNone: () => "",
      onSome: (text) => ` You had entered: ${text}`,
    }
  )}`;
