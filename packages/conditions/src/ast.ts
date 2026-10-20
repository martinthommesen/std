import type { JsonValue } from "@std/values/json-value";
import { Result } from "effect";
/**
 * The condition AST (Contracts 5.2) as TypeScript types, and an Effect Schema
 * for its JSON form, which is how conditions are stored (`condition` fields
 * are `jsonb`) and sent over the wire.
 *
 * Conditions name fields by stable ID (a lowercase UUID). A path of more than
 * one ID follows references: every ID but the last names a reference field,
 * and the next ID is a field of that reference's target class (or one of its
 * ancestors). `image: "previous"` reads the stored record instead of the
 * proposed one (form and record rules only) and applies to the first hop.
 *
 * There is no null literal: emptiness is `empty`. `ne`, `notIn`,
 * `notContains` and `notEmpty` are exactly `not` of their positive forms.
 */
import {
  Array as SchemaArray,
  decodeUnknownResult,
  Int,
  is,
  isPattern,
  Json as JsonSchema,
  Literal,
  Literals,
  optionalKey,
  String as SchemaString,
  Struct,
  suspend,
  Union,
} from "effect/Schema";
import type { Codec, SchemaError } from "effect/Schema";

/** A JSON value as stored in a condition literal. */
export type Json = JsonValue;

/** A field path; more than one ID follows references. */
export interface Path {
  readonly path: readonly string[];
  readonly image?: "previous";
}

/** The comparison operators. */
export type CompareOperator = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

/** Units of `rel: "now"` offsets. */
export type NowUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

/** Units of `rel: "today"` offsets. */
export type TodayUnit = "day" | "week" | "month" | "year";

/** Units of `inPeriod`. */
export type PeriodUnit = "day" | "week" | "month" | "quarter" | "year";

/** A literal in the left field type's canonical JSON form (Contracts 6.5). */
export interface LiteralValue {
  readonly value: Json;
}

/** A context value: the acting user's ID or the evaluation instant. */
export interface ContextValue {
  readonly ctx: "me" | "now";
}

/** A date-time relative to now. */
export interface RelativeToNow {
  readonly rel: "now";
  readonly unit: NowUnit;
  readonly offset: number;
}

/** A date (or the instant it starts) relative to today. */
export interface RelativeToToday {
  readonly rel: "today";
  readonly unit: TodayUnit;
  readonly offset: number;
}

/** The right-hand side of a comparison when it is not a second path. */
export type Value =
  | LiteralValue
  | ContextValue
  | RelativeToNow
  | RelativeToToday;

/** The caller's groups, allowed only as `in(f, myGroups)`. */
export interface MyGroups {
  readonly ctx: "myGroups";
}

/** A period relative to the current one: `offset` 0 is this week. */
export interface Period {
  readonly unit: PeriodUnit;
  readonly offset: number;
}

/** `and []` is true, `or []` is false. */
export interface Junction {
  readonly op: "and" | "or";
  readonly args: readonly Expr[];
}

/** Negation. */
export interface Not {
  readonly op: "not";
  readonly arg: Expr;
}

/** A constant. */
export interface Constant {
  readonly op: "true" | "false";
}

/** `eq` to `ge`: the right side is a value or (for these only) a path. */
export interface Compare {
  readonly op: CompareOperator;
  readonly left: Path;
  readonly right: Path | Value;
}

/** List membership. */
export interface In {
  readonly op: "in" | "notIn";
  readonly left: Path;
  readonly right: readonly Value[] | MyGroups;
}

/** Emptiness. */
export interface Empty {
  readonly op: "empty" | "notEmpty";
  readonly arg: Path;
}

/** The text pattern operators. */
export type PatternOperatorName =
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith";

/** A text pattern test. */
export interface Pattern {
  readonly op: PatternOperatorName;
  readonly left: Path;
  readonly right: string;
}

/** Membership in a calendar period, resolved to `[start, end)`. */
export interface InPeriod {
  readonly op: "inPeriod";
  readonly left: Path;
  readonly period: Period;
}

/** Whether a field's proposed value differs from its stored one. */
export interface Changed {
  readonly op: "changed";
  readonly arg: Path;
}

/** A condition (Contracts 5.2). */
export type Expr =
  | Junction
  | Not
  | Constant
  | Compare
  | In
  | Empty
  | Pattern
  | InPeriod
  | Changed;

/** Every operator name, for coverage and error messages. */
export const OPERATORS = [
  "and",
  "or",
  "not",
  "true",
  "false",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "in",
  "notIn",
  "empty",
  "notEmpty",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "inPeriod",
  "changed",
] as const;

/** An operator name. */
export type OperatorName = (typeof OPERATORS)[number];

/** The operators that test a field (every operator but the connectives). */
export const ATOM_OPERATORS = [
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "in",
  "notIn",
  "empty",
  "notEmpty",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "inPeriod",
  "changed",
] as const;

/** An operator that tests a field. */
export type AtomOperator = (typeof ATOM_OPERATORS)[number];

const UUID_TEXT = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/** A stable ID in its canonical form. */
export const StableIdSchema = SchemaString.check(isPattern(UUID_TEXT));

/**
 * Whether a string is a stable ID in canonical form.
 *
 * @param text - The candidate.
 * @returns True for a lowercase, hyphenated UUID.
 */
export const isStableId = (text: string): boolean => UUID_TEXT.test(text);

/** Schema of a path. */
export const PathSchema = Struct({
  image: optionalKey(Literal("previous")),
  path: SchemaArray(StableIdSchema),
});

const LiteralValueSchema = Struct({ value: JsonSchema });
const ContextValueSchema = Struct({ ctx: Literals(["me", "now"]) });

const RelativeToNowSchema = Struct({
  offset: Int,
  rel: Literal("now"),
  unit: Literals(["minute", "hour", "day", "week", "month", "year"]),
});

const RelativeToTodaySchema = Struct({
  offset: Int,
  rel: Literal("today"),
  unit: Literals(["day", "week", "month", "year"]),
});

/** Schema of a value. */
export const ValueSchema = Union([
  LiteralValueSchema,
  ContextValueSchema,
  RelativeToNowSchema,
  RelativeToTodaySchema,
]);

const MyGroupsSchema = Struct({ ctx: Literal("myGroups") });

/** Schema of the JSON form of a condition. */
export const ExprSchema: Codec<Expr> = Union([
  Struct({
    args: SchemaArray(suspend((): Codec<Expr> => ExprSchema)),
    op: Literals(["and", "or"]),
  }),
  Struct({
    arg: suspend((): Codec<Expr> => ExprSchema),
    op: Literal("not"),
  }),
  Struct({ op: Literals(["true", "false"]) }),
  Struct({
    left: PathSchema,
    op: Literals(["eq", "ne", "lt", "le", "gt", "ge"]),
    right: Union([PathSchema, ValueSchema]),
  }),
  Struct({
    left: PathSchema,
    op: Literals(["in", "notIn"]),
    right: Union([SchemaArray(ValueSchema), MyGroupsSchema]),
  }),
  Struct({ arg: PathSchema, op: Literals(["empty", "notEmpty"]) }),
  Struct({
    left: PathSchema,
    op: Literals(["contains", "notContains", "startsWith", "endsWith"]),
    right: SchemaString,
  }),
  Struct({
    left: PathSchema,
    op: Literal("inPeriod"),
    period: Struct({
      offset: Int,
      unit: Literals(["day", "week", "month", "quarter", "year"]),
    }),
  }),
  Struct({ arg: PathSchema, op: Literal("changed") }),
]);

const decodeStrict = decodeUnknownResult(ExprSchema, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * The deepest condition the engine accepts: nested `and`, `or` and `not`
 * levels, counting the atom. Every recursive function of the engine stays
 * far from the stack limit at this depth. [judgment]
 */
export const MAX_CONDITION_DEPTH = 64;

/**
 * The deepest JSON form `decodeExpr` hands to the schema decoder: enough for
 * {@link MAX_CONDITION_DEPTH} levels (two JSON levels each) plus literals.
 */
export const MAX_CONDITION_JSON_DEPTH = 4 * MAX_CONDITION_DEPTH;

/**
 * The nesting depth of a JSON value, computed without recursion.
 *
 * @param json - Any JSON value.
 * @returns 0 for scalars, 1 for a flat array or object, and so on.
 */
export const jsonDepth = (json: JsonValue): number => {
  let deepest = 0;
  const stack: [JsonValue, number][] = [[json, 0]];

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [value, depth] = entry;

    if (value !== null && value instanceof Object) {
      deepest = Math.max(deepest, depth + 1);

      for (const child of Object.values(value)) {
        stack.push([child, depth + 1]);
      }
    }
  }

  return deepest;
};

const childrenOf = (expr: Expr): readonly Expr[] => {
  if (expr.op === "and" || expr.op === "or") {
    return expr.args;
  }

  return expr.op === "not" ? [expr.arg] : [];
};

/**
 * The depth of a condition (an atom is 1), computed without recursion, so
 * it is safe on any input.
 *
 * @param expr - A condition.
 * @returns The number of nested levels.
 */
export const exprDepth = (expr: Expr): number => {
  let deepest = 0;
  const stack: [Expr, number][] = [[expr, 1]];

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [node, depth] = entry;
    deepest = Math.max(deepest, depth);

    for (const child of childrenOf(node)) {
      stack.push([child, depth + 1]);
    }
  }

  return deepest;
};

/**
 * Whether a typed value really is a condition AST, as the schema defines it
 * (for conditions built in code rather than decoded from JSON).
 */
export const isExpr: (input: Expr) => boolean = is(ExprSchema);

/**
 * Decodes the JSON form of a condition. Unknown keys are refused, so a stored
 * condition cannot carry data that the checker never looked at. This checks
 * the shape only; `checkCondition` checks it against a class and a profile.
 *
 * @param input - JSON parsed with `parseJson` (`@std/values/json`).
 * @returns The condition, the schema error, or `"tooDeep"` when the JSON
 *   nests deeper than {@link MAX_CONDITION_JSON_DEPTH}.
 */
export const decodeExpr = (
  input: JsonValue
): Result.Result<Expr, SchemaError | "tooDeep"> =>
  jsonDepth(input) > MAX_CONDITION_JSON_DEPTH
    ? Result.fail("tooDeep")
    : decodeStrict(input);

/**
 * Whether a comparison's right side is a second path.
 *
 * @param right - The right side of `eq` to `ge`.
 * @returns True for a path.
 */
export const isPath = (right: Path | Value): right is Path => "path" in right;

/**
 * Whether an `in` right side is the caller's groups.
 *
 * @param right - The right side of `in` or `notIn`.
 * @returns True for `{ ctx: "myGroups" }`.
 */
export const isMyGroups = (
  right: readonly Value[] | MyGroups
): right is MyGroups => "ctx" in right;

const COMPARE_OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
]);

const PATTERN_OPERATORS: ReadonlySet<string> = new Set([
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
]);

/**
 * Whether a condition is `and` or `or`.
 *
 * @param expr - A condition.
 * @returns True for junctions.
 */
export const isJunction = (expr: Expr): expr is Junction =>
  expr.op === "and" || expr.op === "or";

/**
 * Whether a condition is `eq` to `ge`.
 *
 * @param expr - A condition.
 * @returns True for comparisons.
 */
export const isCompare = (expr: Expr): expr is Compare =>
  COMPARE_OPERATORS.has(expr.op);

/**
 * Whether a condition is `in` or `notIn`.
 *
 * @param expr - A condition.
 * @returns True for list membership.
 */
export const isIn = (expr: Expr): expr is In =>
  expr.op === "in" || expr.op === "notIn";

/**
 * Whether a condition is `empty` or `notEmpty`.
 *
 * @param expr - A condition.
 * @returns True for emptiness tests.
 */
export const isEmptyTest = (expr: Expr): expr is Empty =>
  expr.op === "empty" || expr.op === "notEmpty";

/**
 * Whether a condition is a text pattern test.
 *
 * @param expr - A condition.
 * @returns True for `contains`, `notContains`, `startsWith`, `endsWith`.
 */
export const isPatternTest = (expr: Expr): expr is Pattern =>
  PATTERN_OPERATORS.has(expr.op);
