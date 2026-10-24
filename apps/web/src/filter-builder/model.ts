import { DatePicker } from "@foldkit/ui";
/**
 * The filter builder's state: a tree that mirrors the condition AST
 * (Contracts 5.2) node for node, so any AST the builder can show loads
 * into it and prints back unchanged. Fields are named by ID, as in the
 * AST; names are only looked up to render and to print.
 *
 * - `Group`: `and` or `or` over its children (`and []` is no filter).
 * - `Negation`: `not` over one node.
 * - `Condition`: one atom: a path (a field, or a reference and a field of
 *   its target), an operator, and the operand the user is editing.
 *
 * An operand holds what the controls hold, as typed (text stays text until
 * the filter is applied), so an unfinished value is never lost and never
 * reaches the server.
 */
import { ATOM_OPERATORS } from "@std/conditions/ast";
import { Schema } from "effect";
import { CalendarDate } from "foldkit/calendar";
import { defineTaggedUnion, taggedStruct } from "foldkit/schema";

/** The operators of the filter profile: every atom but `changed` (5.10). */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const FilterOperator = Schema.Literals(
  ATOM_OPERATORS.filter((operator) => operator !== "changed")
);

/** An operator of the filter profile. */
export type FilterOperator = typeof FilterOperator.Type;

/** Units of a date relative to today (`rel: "today"`). */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const TodayUnit = Schema.Literals(["day", "week", "month", "year"]);

/** A unit of a date relative to today. */
export type TodayUnit = typeof TodayUnit.Type;

/** Units of an instant relative to now (`rel: "now"`). */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const NowUnit = Schema.Literals([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

/** A unit of an instant relative to now. */
export type NowUnit = typeof NowUnit.Type;

/** Units of `inPeriod`. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PeriodUnit = Schema.Literals([
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);

/** A unit of `inPeriod`. */
export type PeriodUnit = typeof PeriodUnit.Type;

/**
 * What a comparison compares with: a literal, the context values `me` and
 * `now`, or a value relative to today or now (Contracts 5.2).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ValueSource = Schema.Literals([
  "value",
  "me",
  "now",
  "today",
  "fromNow",
]);

/** What a comparison compares with. */
export type ValueSource = typeof ValueSource.Type;

/**
 * What a condition compares with, as the user edits it.
 *
 * - `NoValue`: `empty` and `notEmpty`.
 * - `Typed`: a literal typed as text (text, numbers, UUIDs and references)
 *   or a pattern operator's needle.
 * - `Flag`: a boolean literal.
 * - `Choice`: one choice, by key.
 * - `Day`: a date literal, picked with a Date Picker.
 * - `Instant`: a date-time literal: a picked date and a typed `HH:MM` time,
 *   in UTC (decision 0020).
 * - `Me`, `Now`: the context values `me` and `now`.
 * - `Today`, `FromNow`: relative dates and date-times (`rel`), the offset
 *   as typed.
 * - `Lines`: the literals of `in` and `notIn`, one per line.
 * - `ChoiceSet`: the choices of `in` and `notIn`, by key.
 * - `Period`: `inPeriod`'s unit and offset, the offset as typed.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Operand = defineTaggedUnion({
  Choice: { maybeKey: Schema.Option(Schema.String) },
  ChoiceSet: { keys: Schema.Array(Schema.String) },
  Day: { maybeDate: Schema.Option(CalendarDate), picker: DatePicker.Model },
  Flag: { isChecked: Schema.Boolean },
  FromNow: { offset: Schema.String, unit: NowUnit },
  Instant: {
    maybeDate: Schema.Option(CalendarDate),
    picker: DatePicker.Model,
    time: Schema.String,
  },
  Lines: { text: Schema.String },
  Me: {},
  NoValue: {},
  Now: {},
  Period: { offset: Schema.String, unit: PeriodUnit },
  Today: { offset: Schema.String, unit: TodayUnit },
  Typed: { text: Schema.String },
});

/** What a condition compares with. */
export type Operand = typeof Operand.Type;

/** One atom: a path, an operator and an operand. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Condition = taggedStruct("Condition", {
  id: Schema.Int,
  operand: Operand,
  operator: FilterOperator,
  path: Schema.Array(Schema.String),
});

/** One atom. */
export type Condition = typeof Condition.Type;

/** `and` or `or`. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Junction = Schema.Literals(["and", "or"]);

/** `and` or `or`. */
export type Junction = typeof Junction.Type;

/** `and` or `or` over the children. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export type Group = Readonly<{
  _tag: "Group";
  id: number;
  junction: Junction;
  children: readonly FilterNode[];
}>;

/** `not` over one node. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export type Negation = Readonly<{
  _tag: "Negation";
  id: number;
  child: FilterNode;
}>;

/** A node of the builder's tree. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export type FilterNode = Group | Negation | Condition;

/** `and` or `or` over the children. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Group = taggedStruct("Group", {
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<FilterNode> => FilterNode)
  ),
  id: Schema.Int,
  junction: Junction,
});

/** `not` over one node. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Negation = taggedStruct("Negation", {
  child: Schema.suspend((): Schema.Codec<FilterNode> => FilterNode),
  id: Schema.Int,
});

/** A node of the builder's tree. */
// oxlint-disable-next-line no-redeclare -- a recursive Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const FilterNode = Schema.Union([Group, Negation, Condition]);

/**
 * The builder.
 *
 * - `id`: the prefix of its element IDs.
 * - `root`: the tree; `and []` when there is no filter.
 * - `nextNodeId`: the ID the next node gets (IDs are never reused).
 * - `maybeToday`: the calendar's today in UTC, for the Date Pickers'
 *   "today" mark (the device's zone is never used, Contracts 5.7).
 * - `isShowingProblems`: an apply found values that do not convert; each
 *   condition shows its problem until the next apply.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = Schema.Struct({
  id: Schema.String,
  isShowingProblems: Schema.Boolean,
  maybeToday: Schema.Option(CalendarDate),
  nextNodeId: Schema.Int,
  root: FilterNode,
});

/** The builder. */
export type Model = typeof Model.Type;
