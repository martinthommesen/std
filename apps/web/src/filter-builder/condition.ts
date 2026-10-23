/**
 * The builder's tree and the condition AST (Contracts 5.2), both ways:
 *
 * - {@link toCondition}: the AST the builder shows, with every literal in
 *   its left field's canonical JSON (6.5): integers as numbers, big
 *   integers and decimals as digit strings, dates `YYYY-MM-DD`, date-times
 *   as UTC instants, text after the write conversion (5.5), UUIDs in
 *   lowercase. A value that does not convert is a problem on its
 *   condition, and nothing is sent.
 * - {@link loadCondition}: the builder for a stored AST (a saved filter,
 *   the address bar), or why it cannot be shown. The builder shows `and`,
 *   `or`, `not` and every filter-profile atom with a literal, `me`, `now`
 *   or relative right side over a path of at most one hop; it does not
 *   show constants, field-to-field comparisons, `myGroups`, `changed`,
 *   `previous`, or date-times with seconds.
 *
 * Both only read metadata the browser holds: the table's and, for paths,
 * the target tables'.
 */
import { DatePicker } from "@foldkit/ui";
import type {
  Expr,
  Path,
  PatternOperatorName,
  Value,
} from "@std/conditions/ast";
import { isCompare, isPath } from "@std/conditions/ast";
import { MAX_RELATIVE_OFFSET } from "@std/conditions/check";
import { parseChoiceKey } from "@std/values/choice";
import { parseDate } from "@std/values/date";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import { formatDecimal, parseDecimal } from "@std/values/decimal";
import type { Decoded } from "@std/values/field-error";
import type { FieldKind } from "@std/values/field-type";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import {
  convertLiteral,
  convertNeedleLiteral,
  convertNumberText,
} from "@std/values/literal";
import { parseUuid } from "@std/values/uuid";
import { Match, Option, Result, pipe } from "effect";
import type { CalendarDate } from "foldkit/calendar";

import type { MetaField, MetaTable } from "../domain/metadata.ts";
import { fieldById } from "../domain/table-view.ts";
import type { TablesByName } from "../domain/table-view.ts";
import { Condition, Group, Negation, Operand } from "./model.ts";
import type { FilterNode, FilterOperator } from "./model.ts";
import { operatorsFor } from "./operators.ts";

/** The tables a condition may name, and the one it applies to. */
export interface ConditionScope {
  /** The table the filter applies to. */
  readonly table: string;
  /** Metadata the browser holds: the table and loaded reference targets. */
  readonly tables: TablesByName;
}

/** Why a condition of the builder does not convert. */
export interface ConditionProblem {
  /** The condition's node ID. */
  readonly conditionId: number;
  /** What to fix, naming no value. */
  readonly message: string;
}

/** A path's fields, from the table to the field compared. */
export interface ResolvedPath {
  /** Each field with the table it was read on. */
  readonly hops: readonly {
    readonly table: MetaTable;
    readonly field: MetaField;
  }[];
  /** The field compared: the last hop's. */
  readonly field: MetaField;
}

/**
 * A reference field's target table, when the browser holds its metadata.
 *
 * @param field - A field.
 * @param tables - The tables the browser holds.
 * @returns The target's metadata.
 */
export const targetOf = (
  field: MetaField,
  tables: TablesByName
): Option.Option<MetaTable> =>
  field.type.kind === "reference" && field.type.target !== null
    ? Option.fromNullishOr(tables.get(field.type.target))
    : Option.none();

/**
 * Resolves a path: one field of the table, or a reference and a field of
 * its target (one hop, the filter profile's limit).
 *
 * @param path - Field IDs.
 * @param scope - The tables.
 * @returns The fields, or none when a field is not (or no longer) there.
 */
export const resolvePath = (
  path: readonly string[],
  scope: ConditionScope
): Option.Option<ResolvedPath> => {
  const table = scope.tables.get(scope.table);
  const [firstId, secondId, ...rest] = path;

  if (table === undefined || firstId === undefined || rest.length > 0) {
    return Option.none();
  }

  return Option.flatMap(fieldById(table, firstId), (first) => {
    if (secondId === undefined) {
      return Option.some({ field: first, hops: [{ field: first, table }] });
    }

    return Option.flatMap(targetOf(first, scope.tables), (target) =>
      Option.map(fieldById(target, secondId), (second) => ({
        field: second,
        hops: [
          { field: first, table },
          { field: second, table: target },
        ],
      }))
    );
  });
};

/**
 * A calendar date as `YYYY-MM-DD`.
 *
 * @param date - The date.
 * @returns Its canonical text.
 */
export const isoDateOf = (date: CalendarDate): string =>
  [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");

/**
 * A canonical `YYYY-MM-DD` date as a calendar date.
 *
 * @param text - The date.
 * @returns The calendar date, or none when it is not a valid date.
 */
export const calendarDateOf = (text: string): Option.Option<CalendarDate> => {
  const parsed = parseDate(text);

  if (!parsed.ok) {
    return Option.none();
  }

  const [year = "", month = "", day = ""] = parsed.value.split("-");

  return Option.some({
    day: Number(day),
    month: Number(month),
    year: Number(year),
  });
};

type NumberKind = Extract<FieldKind, "integer" | "bigInteger" | "decimal">;

const TIME_TEXT = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

const INTEGER_TEXT = /^-?\d+$/u;

type Converted<A> = Result.Result<A, string>;

const fromDecoded = <A>(decoded: Decoded<A>): Converted<A> =>
  decoded.ok
    ? Result.succeed(decoded.value)
    : Result.fail(decoded.error.message);

/**
 * An offset as typed, as a whole number within the checker's limit
 * (`-0` reads as 0, as in the text syntax).
 *
 * @param text - The offset as typed.
 * @returns The offset, or what is wrong.
 */
export const parseOffset = (text: string): Converted<number> => {
  const trimmed = text.trim();
  const offset = Number(trimmed);

  const isInRange =
    INTEGER_TEXT.test(trimmed) &&
    Number.isSafeInteger(offset) &&
    Math.abs(offset) <= MAX_RELATIVE_OFFSET;

  if (!isInRange) {
    return Result.fail(
      `Enter a whole number from -${MAX_RELATIVE_OFFSET} to ${MAX_RELATIVE_OFFSET}.`
    );
  }

  return Result.succeed(offset === 0 ? 0 : offset);
};

const numberLiteral = (kind: NumberKind, text: string): Converted<JsonValue> =>
  Match.value(kind).pipe(
    Match.withReturnType<Converted<JsonValue>>(),
    Match.when("integer", () =>
      Result.map(Number)(fromDecoded(convertNumberText("integer", text.trim())))
    ),
    Match.when("bigInteger", () =>
      Result.map(String)(
        fromDecoded(convertNumberText("bigInteger", text.trim()))
      )
    ),
    Match.when("decimal", () =>
      Result.map(formatDecimal)(fromDecoded(parseDecimal(text.trim())))
    ),
    Match.exhaustive
  );

const choiceLiteral = (field: MetaField, text: string): Converted<JsonValue> =>
  Result.flatMap(fromDecoded(parseChoiceKey(text)), (key) =>
    (field.choices ?? []).some((choice) => choice.key === key)
      ? Result.succeed(key)
      : Result.fail("Choose one of the field's choices.")
  );

/**
 * A literal typed as text, in the field type's canonical JSON (6.5), then
 * checked as the server checks condition literals (`convertLiteral`).
 *
 * @param field - The left field.
 * @param text - The literal as typed.
 * @returns The literal, or what is wrong.
 */
export const literalFromText = (
  field: MetaField,
  text: string
): Converted<JsonValue> => {
  const { kind } = field.type;

  const canonical = Match.value(kind).pipe(
    Match.withReturnType<Converted<JsonValue>>(),
    Match.when(Match.is("integer", "bigInteger", "decimal"), (numberKind) =>
      numberLiteral(numberKind, text)
    ),
    Match.when(Match.is("text", "longText"), (textKind) =>
      Result.map(String)(fromDecoded(convertLiteral(textKind, text)))
    ),
    Match.when(Match.is("uuid", "reference"), () =>
      fromDecoded(parseUuid(text.trim()))
    ),
    Match.when("date", () => fromDecoded(parseDate(text.trim()))),
    Match.when("dateTime", () =>
      Result.map(fromDecoded(parseDateTime(text.trim())), formatDateTime)
    ),
    Match.when("boolean", () => {
      const trimmed = text.trim();

      return trimmed === "true" || trimmed === "false"
        ? Result.succeed(trimmed === "true")
        : Result.fail("Enter true or false.");
    }),
    Match.when("choice", () => choiceLiteral(field, text.trim())),
    Match.orElse(() =>
      Result.fail("This field type has no values to compare with.")
    )
  );

  return pipe(
    canonical,
    Result.flatMap((json) =>
      Result.map(() => json)(fromDecoded(convertLiteral(kind, json)))
    )
  );
};

const lineLiterals = (
  field: MetaField,
  text: string
): Converted<readonly Value[]> => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    return Result.fail("Enter at least one value, one per line.");
  }

  return Result.all(
    lines.map((line) =>
      Result.map(literalFromText(field, line), (value) => ({ value }))
    )
  );
};

const instantLiteral = (
  maybeDate: Option.Option<CalendarDate>,
  time: string
): Converted<JsonValue> => {
  const clock = TIME_TEXT.exec(time.trim())?.groups;

  return Option.match(maybeDate, {
    onNone: () => Result.fail("Pick a date."),
    onSome: (date) =>
      clock === undefined
        ? Result.fail("Enter the time as HH:MM (UTC).")
        : Result.map(
            fromDecoded(
              parseDateTime(
                `${isoDateOf(date)}T${clock.hour}:${clock.minute}:00.000Z`
              )
            ),
            formatDateTime
          ),
  });
};

const comparisonValue = (
  field: MetaField,
  operand: Operand
): Converted<Value> =>
  Match.value(operand).pipe(
    Match.withReturnType<Converted<Value>>(),
    Match.tag("Typed", ({ text }) =>
      Result.map(literalFromText(field, text), (value) => ({ value }))
    ),
    Match.tag("Flag", ({ isChecked }) => Result.succeed({ value: isChecked })),
    Match.tag("Choice", ({ maybeKey }) =>
      Option.match(maybeKey, {
        onNone: () => Result.fail("Choose a value."),
        onSome: (key) => Result.succeed({ value: key }),
      })
    ),
    Match.tag("Day", ({ maybeDate }) =>
      Option.match(maybeDate, {
        onNone: () => Result.fail("Pick a date."),
        onSome: (date) => Result.succeed({ value: isoDateOf(date) }),
      })
    ),
    Match.tag("Instant", ({ maybeDate, time }) =>
      Result.map(instantLiteral(maybeDate, time), (value) => ({ value }))
    ),
    Match.tag("Me", () => Result.succeed({ ctx: "me" as const })),
    Match.tag("Now", () => Result.succeed({ ctx: "now" as const })),
    Match.tag("Today", ({ offset, unit }) =>
      Result.map(parseOffset(offset), (parsed) => ({
        offset: parsed,
        rel: "today" as const,
        unit,
      }))
    ),
    Match.tag("FromNow", ({ offset, unit }) =>
      Result.map(parseOffset(offset), (parsed) => ({
        offset: parsed,
        rel: "now" as const,
        unit,
      }))
    ),
    Match.orElse(() => Result.fail("Choose a value."))
  );

const PATTERN_KINDS: ReadonlySet<FieldKind> = new Set(["text", "longText"]);

const needle = (
  field: MetaField,
  operator: PatternOperatorName,
  operand: Operand
): Converted<string> => {
  const { kind } = field.type;

  if (!Operand.guards.Typed(operand) || !PATTERN_KINDS.has(kind)) {
    return Result.fail("Enter the text to look for.");
  }

  return fromDecoded(
    convertNeedleLiteral(
      operator === "notContains" ? "contains" : operator,
      kind === "longText" ? "longText" : "text",
      operand.text
    )
  );
};

const membership = (
  field: MetaField,
  operand: Operand
): Converted<readonly Value[]> => {
  if (Operand.guards.ChoiceSet(operand)) {
    return operand.keys.length === 0
      ? Result.fail("Choose at least one value.")
      : Result.succeed(operand.keys.map((key) => ({ value: key })));
  }

  return Operand.guards.Lines(operand)
    ? lineLiterals(field, operand.text)
    : Result.fail("Enter at least one value, one per line.");
};

const COMPARISON_OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;

const PATTERN_OPERATORS = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
] as const;

const atomOf = (
  operator: FilterOperator,
  left: Path,
  field: MetaField,
  operand: Operand
): Converted<Expr> =>
  Match.value(operator).pipe(
    Match.withReturnType<Converted<Expr>>(),
    Match.when(Match.is("empty", "notEmpty"), (op) =>
      Result.succeed({ arg: left, op })
    ),
    Match.when("inPeriod", () =>
      Operand.guards.Period(operand)
        ? Result.map(parseOffset(operand.offset), (offset) => ({
            left,
            op: "inPeriod" as const,
            period: { offset, unit: operand.unit },
          }))
        : Result.fail("Choose a period.")
    ),
    Match.when(Match.is("in", "notIn"), (op) =>
      Result.map(membership(field, operand), (right) => ({ left, op, right }))
    ),
    Match.when(Match.is(...PATTERN_OPERATORS), (op) =>
      Result.map(needle(field, op, operand), (right) => ({ left, op, right }))
    ),
    Match.when(Match.is(...COMPARISON_OPERATORS), (op) =>
      Result.map(comparisonValue(field, operand), (right) => ({
        left,
        op,
        right,
      }))
    ),
    Match.exhaustive
  );

/**
 * One condition as an AST atom.
 *
 * @param condition - The condition.
 * @param scope - The tables.
 * @returns The atom, or what is wrong.
 */
export const conditionToExpr = (
  condition: Condition,
  scope: ConditionScope
): Converted<Expr> =>
  Option.match(resolvePath(condition.path, scope), {
    onNone: () =>
      Result.fail("This field is no longer available. Choose another."),
    onSome: ({ field }) =>
      operatorsFor(field.type.kind).includes(condition.operator)
        ? atomOf(
            condition.operator,
            { path: condition.path },
            field,
            condition.operand
          )
        : Result.fail("Choose an operator for this field."),
  });

interface Collected {
  readonly expr: Expr;
  readonly problems: readonly ConditionProblem[];
}

const PLACEHOLDER: Expr = { op: "true" };

const EMPTY_GROUP =
  "This group has no conditions. Add one or remove the group.";

const collect = (node: FilterNode, scope: ConditionScope): Collected => {
  if (node._tag === "Group") {
    const children = node.children.map((child) => collect(child, scope));

    // NOTE: `and []` is true and `or []` false (5.2); a group left empty
    // in the builder is almost always unfinished, so it is refused.
    const emptyGroup: readonly ConditionProblem[] =
      node.children.length === 0
        ? [{ conditionId: node.id, message: EMPTY_GROUP }]
        : [];

    return {
      expr: { args: children.map((child) => child.expr), op: node.junction },
      problems: [...emptyGroup, ...children.flatMap((child) => child.problems)],
    };
  }

  if (node._tag === "Negation") {
    const child = collect(node.child, scope);

    return { expr: { arg: child.expr, op: "not" }, problems: child.problems };
  }

  return Result.match(conditionToExpr(node, scope), {
    onFailure: (message) => ({
      expr: PLACEHOLDER,
      problems: [{ conditionId: node.id, message }],
    }),
    onSuccess: (expr) => ({ expr, problems: [] }),
  });
};

/**
 * The builder's tree as a condition AST.
 *
 * @param root - The tree.
 * @param scope - The tables.
 * @returns The AST, or every condition's (and empty group's) problem.
 */
export const toCondition = (
  root: FilterNode,
  scope: ConditionScope
): Result.Result<Expr, readonly ConditionProblem[]> => {
  const collected = collect(root, scope);

  return collected.problems.length === 0
    ? Result.succeed(collected.expr)
    : Result.fail(collected.problems);
};

/**
 * The problem of each condition, by node ID, for the view.
 *
 * @param root - The tree.
 * @param scope - The tables.
 * @returns Problems by condition ID.
 */
export const problemsByCondition = (
  root: FilterNode,
  scope: ConditionScope
): ReadonlyMap<number, string> =>
  new Map(
    collect(root, scope).problems.map((problem) => [
      problem.conditionId,
      problem.message,
    ])
  );

/**
 * Whether a tree is the empty filter (`and []`).
 *
 * @param root - The tree.
 * @returns True when there is no condition at all.
 */
export const isEmptyFilter = (root: FilterNode): boolean =>
  root._tag === "Group" &&
  root.junction === "and" &&
  root.children.length === 0;

// LOAD

/** Why a stored condition cannot be shown in the builder. */
export interface LoadProblem {
  readonly message: string;
}

/** What loading needs besides the tables. */
export interface LoadContext extends ConditionScope {
  /** The ID of the first node; the next ones follow. */
  readonly firstNodeId: number;
  /** The builder's element ID prefix, for Date Picker IDs. */
  readonly builderId: string;
  /** The calendar's today, for the Date Pickers. */
  readonly today: CalendarDate;
}

/**
 * The element ID of a condition's Date Picker.
 *
 * @param builderId - The builder's ID.
 * @param conditionId - The condition's node ID.
 * @returns The ID.
 */
export const pickerIdOf = (builderId: string, conditionId: number): string =>
  `${builderId}-condition-${conditionId}-date`;

interface Loader {
  readonly context: LoadContext;
  nextId: number;
}

class CannotLoadError extends Error {
  override readonly name = "CannotLoadError";
}

const cannotLoad = (message: string): never => {
  throw new CannotLoadError(message);
};

const takeId = (loader: Loader): number => {
  const id = loader.nextId;
  loader.nextId += 1;

  return id;
};

const textOfLiteral = (value: JsonValue): string => {
  if (isJsonString(value)) {
    return value.includes("\n")
      ? cannotLoad("A list value spans several lines.")
      : value;
  }

  if (isJsonNumber(value) || isJsonBoolean(value)) {
    return String(value);
  }

  return cannotLoad("A value is not a plain literal.");
};

const literalOf = (value: Value): JsonValue =>
  "value" in value ? value.value : cannotLoad("A list holds a context value.");

const MINUTE_INSTANT =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2}:\d{2}):00\.000Z$/u;

const pickerFor = (loader: Loader, conditionId: number) =>
  DatePicker.init({
    id: pickerIdOf(loader.context.builderId, conditionId),
    today: loader.context.today,
  });

const literalOperandOf = (
  loader: Loader,
  conditionId: number,
  field: MetaField,
  value: JsonValue
): Operand => {
  const { kind } = field.type;

  if (kind === "boolean" && isJsonBoolean(value)) {
    return Operand.Flag({ isChecked: value });
  }

  if (kind === "choice" && isJsonString(value)) {
    return Operand.Choice({ maybeKey: Option.some(value) });
  }

  if (kind === "date" && isJsonString(value)) {
    return Operand.Day({
      maybeDate: Option.some(
        Option.getOrElse(calendarDateOf(value), () =>
          cannotLoad("A date literal is not a date.")
        )
      ),
      picker: pickerFor(loader, conditionId),
    });
  }

  if (kind === "dateTime" && isJsonString(value)) {
    const parts = MINUTE_INSTANT.exec(value)?.groups;

    return Operand.Instant({
      maybeDate: calendarDateOf(
        parts?.date ?? cannotLoad("A date-time literal has seconds.")
      ),
      picker: pickerFor(loader, conditionId),
      time: parts?.time ?? "",
    });
  }

  return Operand.Typed({ text: textOfLiteral(value) });
};

const comparisonOperandOf = (
  loader: Loader,
  conditionId: number,
  field: MetaField,
  right: Path | Value
): Operand => {
  if (isPath(right)) {
    return cannotLoad("A comparison with another field.");
  }

  if ("value" in right) {
    return literalOperandOf(loader, conditionId, field, right.value);
  }

  if ("ctx" in right) {
    return right.ctx === "me" ? Operand.Me() : Operand.Now();
  }

  return right.rel === "today"
    ? Operand.Today({ offset: String(right.offset), unit: right.unit })
    : Operand.FromNow({ offset: String(right.offset), unit: right.unit });
};

const loadPath = (loader: Loader, path: Path): MetaField => {
  if (path.image !== undefined) {
    return cannotLoad("A path reads the previous record.");
  }

  return Option.match(resolvePath(path.path, loader.context), {
    onNone: () => cannotLoad("A field is unknown or not readable."),
    onSome: ({ field }) => field,
  });
};

const membershipOperandOf = (
  field: MetaField,
  right: readonly Value[] | { readonly ctx: "myGroups" }
): Operand => {
  if (!Array.isArray(right)) {
    return cannotLoad("A list of the caller's groups.");
  }

  const values = right.map(literalOf);

  return field.type.kind === "choice"
    ? Operand.ChoiceSet({ keys: values.map(textOfLiteral) })
    : Operand.Lines({ text: values.map(textOfLiteral).join("\n") });
};

const loadAtom = (loader: Loader, expr: Expr): Condition => {
  const id = takeId(loader);

  const atom = Match.value(expr).pipe(
    Match.withReturnType<{
      readonly operator: FilterOperator;
      readonly path: Path;
      readonly operand: (field: MetaField) => Operand;
    }>(),
    Match.when({ op: Match.is("empty", "notEmpty") }, (empty) => ({
      operand: () => Operand.NoValue(),
      operator: empty.op,
      path: empty.arg,
    })),
    Match.when({ op: "inPeriod" }, (inPeriod) => ({
      operand: () =>
        Operand.Period({
          offset: String(inPeriod.period.offset),
          unit: inPeriod.period.unit,
        }),
      operator: "inPeriod",
      path: inPeriod.left,
    })),
    Match.when({ op: Match.is("in", "notIn") }, (membershipExpr) => ({
      operand: (field) => membershipOperandOf(field, membershipExpr.right),
      operator: membershipExpr.op,
      path: membershipExpr.left,
    })),
    Match.when({ op: Match.is(...PATTERN_OPERATORS) }, (pattern) => ({
      operand: () => Operand.Typed({ text: pattern.right }),
      operator: pattern.op,
      path: pattern.left,
    })),
    Match.when({ op: Match.is(...COMPARISON_OPERATORS) }, (comparison) => ({
      operand: (field) =>
        comparisonOperandOf(loader, id, field, comparison.right),
      operator: comparison.op,
      path: comparison.left,
    })),
    Match.orElse(() =>
      cannotLoad("The condition uses an operator the builder does not show.")
    )
  );

  const field = loadPath(loader, atom.path);

  if (!operatorsFor(field.type.kind).includes(atom.operator)) {
    return cannotLoad("An operator does not fit its field.");
  }

  return Condition({
    id,
    operand: atom.operand(field),
    operator: atom.operator,
    path: atom.path.path,
  });
};

const loadNode = (loader: Loader, expr: Expr): FilterNode => {
  if (expr.op === "and" || expr.op === "or") {
    const id = takeId(loader);

    return Group({
      children: expr.args.map((arg) => loadNode(loader, arg)),
      id,
      junction: expr.op,
    });
  }

  if (expr.op === "not") {
    const id = takeId(loader);

    return Negation({ child: loadNode(loader, expr.arg), id });
  }

  return loadAtom(loader, expr);
};

/** A loaded tree and the next free node ID. */
export interface Loaded {
  readonly root: FilterNode;
  readonly nextNodeId: number;
}

/**
 * The builder's tree for a stored condition AST, when the builder can show
 * it: every field it names must be in the metadata the browser holds.
 *
 * @param expr - The condition.
 * @param context - The tables, the first node ID, the builder ID, today.
 * @returns The tree, or why it cannot be shown.
 */
export const loadCondition = (
  expr: Expr,
  context: LoadContext
): Result.Result<Loaded, LoadProblem> => {
  const loader: Loader = { context, nextId: context.firstNodeId };

  try {
    const root = loadNode(loader, expr);

    return Result.succeed({ nextNodeId: loader.nextId, root });
  } catch (error) {
    if (error instanceof CannotLoadError) {
      return Result.fail({ message: error.message });
    }

    throw error;
  }
};

/**
 * The paths of an atom: its left side and, for a field-to-field
 * comparison, its right side.
 *
 * @param atom - An atom.
 * @returns Its paths.
 */
const pathsOf = (atom: Expr): readonly Path[] => {
  if (isCompare(atom)) {
    return isPath(atom.right) ? [atom.left, atom.right] : [atom.left];
  }

  if ("left" in atom) {
    return [atom.left];
  }

  return "arg" in atom && atom.op !== "not" ? [atom.arg] : [];
};

const atomsOf = (expr: Expr): readonly Expr[] => {
  if (expr.op === "and" || expr.op === "or") {
    return expr.args.flatMap(atomsOf);
  }

  return expr.op === "not" ? atomsOf(expr.arg) : [expr];
};

/**
 * The reference fields a stored condition follows, whose target tables
 * the browser must hold before the condition loads.
 *
 * @param expr - The condition.
 * @returns The first field ID of every path with a hop.
 */
export const followedReferences = (expr: Expr): ReadonlySet<string> =>
  new Set(
    atomsOf(expr).flatMap((atom) =>
      pathsOf(atom).flatMap(({ path }) => {
        const [first, second] = path;

        return first !== undefined && second !== undefined ? [first] : [];
      })
    )
  );

/**
 * Whether the builder offers a field: it is active and has an operator.
 *
 * @param field - The field.
 * @returns True when it can be filtered on.
 */
export const isFilterable = (field: MetaField): boolean =>
  field.state === "active" && operatorsFor(field.type.kind).length > 0;
