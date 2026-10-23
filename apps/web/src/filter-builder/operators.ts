/**
 * What the builder offers for a field: the operators the filter profile
 * allows for its type (Contracts 5.4, 5.10: every operator but `changed`,
 * per `@std/conditions/profile`), what a comparison may compare with, the
 * units of relative values, and the operand each choice starts with.
 */
import { DatePicker } from "@foldkit/ui";
import { operatorFitsKind } from "@std/conditions/profile";
import { FIELD_KINDS } from "@std/values/field-type";
import type { FieldKind } from "@std/values/field-type";
import { Match, Option } from "effect";
import type { CalendarDate } from "foldkit/calendar";

import type { MetaField } from "../domain/metadata.ts";
import { FilterOperator, Operand } from "./model.ts";
import type { ValueSource } from "./model.ts";

/** Every filter operator, in the order the builder lists them. */
export const FILTER_OPERATORS: readonly FilterOperator[] =
  FilterOperator.literals;

const OPERATORS_BY_KIND: ReadonlyMap<FieldKind, readonly FilterOperator[]> =
  new Map(
    FIELD_KINDS.map((kind) => [
      kind,
      FILTER_OPERATORS.filter((operator) => operatorFitsKind(operator, kind)),
    ])
  );

/** The table that holds users: `me` compares with references to it. */
export const USER_TABLE = "core.user";

/**
 * The operators the filter profile allows for a field type.
 *
 * @param kind - The field's kind.
 * @returns The operators, in builder order.
 */
export const operatorsFor = (kind: FieldKind): readonly FilterOperator[] =>
  OPERATORS_BY_KIND.get(kind) ?? [];

/** The comparisons `eq` to `ge`, which take a value, `me`, `now` or `rel`. */
const COMPARISONS: ReadonlySet<FilterOperator> = new Set([
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
]);

/** The pattern operators, which take a needle. */
const PATTERNS: ReadonlySet<FilterOperator> = new Set([
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
]);

/**
 * Whether an operator compares with one value.
 *
 * @param operator - The operator.
 * @returns True for `eq` to `ge`.
 */
export const isComparison = (operator: FilterOperator): boolean =>
  COMPARISONS.has(operator);

/**
 * Whether an operator matches text patterns.
 *
 * @param operator - The operator.
 * @returns True for `contains`, `notContains`, `startsWith`, `endsWith`.
 */
export const isPattern = (operator: FilterOperator): boolean =>
  PATTERNS.has(operator);

const DATE_KINDS: ReadonlySet<FieldKind> = new Set(["date", "dateTime"]);

const isDateKind = (kind: FieldKind): boolean => DATE_KINDS.has(kind);

/**
 * The label of an operator for a field type: dates read "before" and
 * "after", numbers "less" and "greater".
 *
 * @param operator - The operator.
 * @param kind - The field's kind.
 * @returns The label.
 */
export const operatorLabel = (
  operator: FilterOperator,
  kind: FieldKind
): string =>
  Match.value(operator).pipe(
    Match.when("eq", () => "is"),
    Match.when("ne", () => "is not"),
    Match.when("lt", () => (isDateKind(kind) ? "is before" : "is less than")),
    Match.when("le", () =>
      isDateKind(kind) ? "is on or before" : "is at most"
    ),
    Match.when("gt", () => (isDateKind(kind) ? "is after" : "is greater than")),
    Match.when("ge", () =>
      isDateKind(kind) ? "is on or after" : "is at least"
    ),
    Match.when("in", () => "is one of"),
    Match.when("notIn", () => "is not one of"),
    Match.when("empty", () => "is empty"),
    Match.when("notEmpty", () => "is not empty"),
    Match.when("contains", () => "contains"),
    Match.when("notContains", () => "does not contain"),
    Match.when("startsWith", () => "starts with"),
    Match.when("endsWith", () => "ends with"),
    Match.when("inPeriod", () => "is in the period"),
    Match.exhaustive
  );

/**
 * What a comparison of a field may compare with: `me` only for references
 * to users, `now` and relative instants for date-times, relative dates for
 * dates and date-times (the checker's rules, `@std/conditions/check`).
 *
 * @param field - The left field.
 * @returns The sources, the literal first.
 */
export const valueSourcesFor = (field: MetaField): readonly ValueSource[] => {
  const { type } = field;

  if (type.kind === "reference" && type.target === USER_TABLE) {
    return ["value", "me"];
  }

  if (type.kind === "dateTime") {
    return ["value", "today", "now", "fromNow"];
  }

  return type.kind === "date" ? ["value", "today"] : ["value"];
};

/**
 * The label of a value source.
 *
 * @param source - The source.
 * @returns Its label.
 */
export const valueSourceLabel = (source: ValueSource): string =>
  Match.value(source).pipe(
    Match.when("value", () => "a value"),
    Match.when("me", () => "me (the signed-in user)"),
    Match.when("now", () => "now"),
    Match.when("today", () => "a date relative to today"),
    Match.when("fromNow", () => "a time relative to now"),
    Match.exhaustive
  );

/**
 * The value source an operand stands for.
 *
 * @param operand - The operand of a comparison.
 * @returns Its source.
 */
export const valueSourceOf = (operand: Operand): ValueSource =>
  Match.value(operand).pipe(
    Match.tag("Me", () => "me" as const),
    Match.tag("Now", () => "now" as const),
    Match.tag("Today", () => "today" as const),
    Match.tag("FromNow", () => "fromNow" as const),
    Match.orElse(() => "value" as const)
  );

/** What a new operand needs besides the field. */
export interface OperandContext {
  /** The element ID of a Date Picker the operand may need. */
  readonly pickerId: string;
  /** The calendar's today, for a Date Picker's "today" mark. */
  readonly today: CalendarDate;
}

/** The kinds whose literals are typed as text into an Input. */
const TYPED_KINDS: ReadonlySet<FieldKind> = new Set([
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "uuid",
  "reference",
]);

const literalOperand = (kind: FieldKind, context: OperandContext): Operand =>
  Match.value(kind).pipe(
    Match.when("boolean", () => Operand.Flag({ isChecked: true })),
    Match.when("choice", () => Operand.Choice({ maybeKey: Option.none() })),
    Match.when("date", () =>
      Operand.Day({
        maybeDate: Option.none(),
        picker: DatePicker.init({ id: context.pickerId, today: context.today }),
      })
    ),
    Match.when("dateTime", () =>
      Operand.Instant({
        maybeDate: Option.none(),
        picker: DatePicker.init({ id: context.pickerId, today: context.today }),
        time: "00:00",
      })
    ),
    Match.orElse(() => Operand.Typed({ text: "" }))
  );

/**
 * The operand a comparison starts with when its value source is chosen.
 *
 * @param kind - The left field's kind.
 * @param source - The value source.
 * @param context - Picker ID and today.
 * @returns The operand.
 */
export const operandForSource = (
  kind: FieldKind,
  source: ValueSource,
  context: OperandContext
): Operand =>
  Match.value(source).pipe(
    Match.when("value", () => literalOperand(kind, context)),
    Match.when("me", () => Operand.Me()),
    Match.when("now", () => Operand.Now()),
    Match.when("today", () => Operand.Today({ offset: "0", unit: "day" })),
    Match.when("fromNow", () =>
      Operand.FromNow({ offset: "-1", unit: "hour" })
    ),
    Match.exhaustive
  );

/**
 * The operand a condition starts with for an operator.
 *
 * @param kind - The left field's kind.
 * @param operator - The operator.
 * @param context - Picker ID and today.
 * @returns The operand.
 */
export const defaultOperand = (
  kind: FieldKind,
  operator: FilterOperator,
  context: OperandContext
): Operand => {
  if (operator === "empty" || operator === "notEmpty") {
    return Operand.NoValue();
  }

  if (operator === "inPeriod") {
    return Operand.Period({ offset: "0", unit: "month" });
  }

  if (operator === "in" || operator === "notIn") {
    return kind === "choice"
      ? Operand.ChoiceSet({ keys: [] })
      : Operand.Lines({ text: "" });
  }

  return isPattern(operator)
    ? Operand.Typed({ text: "" })
    : literalOperand(kind, context);
};

/**
 * Whether an operand still fits an operator and field type, so that
 * changing the operator can keep what the user entered.
 *
 * @param operand - The operand.
 * @param kind - The left field's kind.
 * @param operator - The new operator.
 * @returns True when the operand stays.
 */
export const operandFits = (
  operand: Operand,
  kind: FieldKind,
  operator: FilterOperator
): boolean =>
  Match.value(operand).pipe(
    Match.tag("NoValue", () => operator === "empty" || operator === "notEmpty"),
    Match.tag("Period", () => operator === "inPeriod"),
    Match.tag(
      "Lines",
      "ChoiceSet",
      () => operator === "in" || operator === "notIn"
    ),
    Match.tag(
      "Typed",
      () =>
        isPattern(operator) || (isComparison(operator) && TYPED_KINDS.has(kind))
    ),
    Match.orElse(() => isComparison(operator))
  );
