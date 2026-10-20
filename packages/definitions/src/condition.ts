/**
 * Stored conditions (Contracts 5.2), structurally.
 *
 * INTEGRATION POINT (the conditions package): this module only checks the
 * shape of a condition AST and lists the field IDs it reads. When the
 * conditions package lands, `ConditionSchema` becomes its `Expr` schema, and
 * `conditionProblems` in `validate.ts` calls its checker (field types,
 * operators per type, literal conversion, the access-rule and subscription
 * profiles). Until then the schema engine accepts any well-formed AST whose
 * paths name fields of the rule's class or its ancestors.
 */
import {
  Array as SchemaArray,
  Int,
  Json,
  Literal,
  Literals,
  optionalKey,
  String as SchemaString,
  Struct,
  suspend,
  Union,
} from "effect/Schema";
import type { Codec } from "effect/Schema";

import { compareIds, DefinitionIdSchema } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";

/** A field path: one ID, or several following references. */
export const ConditionPathSchema = Struct({
  image: optionalKey(Literal("previous")),
  path: SchemaArray(DefinitionIdSchema),
});

/** A field path. */
export type ConditionPath = typeof ConditionPathSchema.Type;

const LiteralValueSchema = Struct({ value: Json });

/** A right-hand value: a literal, a context value or a relative date. */
export const ConditionValueSchema = Union([
  LiteralValueSchema,
  Struct({ ctx: Literals(["me", "now"]) }),
  Struct({
    offset: Int,
    rel: Literal("now"),
    unit: Literals(["minute", "hour", "day", "week", "month", "year"]),
  }),
  Struct({
    offset: Int,
    rel: Literal("today"),
    unit: Literals(["day", "week", "month", "year"]),
  }),
]);

/** A right-hand value. */
export type ConditionValue = typeof ConditionValueSchema.Type;

const ComparisonOpSchema = Literals(["eq", "ne", "lt", "le", "gt", "ge"]);

const PatternOpSchema = Literals([
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
]);

const PeriodSchema = Struct({
  offset: Int,
  unit: Literals(["day", "week", "month", "quarter", "year"]),
});

const MembershipRightSchema = Union([
  SchemaArray(LiteralValueSchema),
  Struct({ ctx: Literal("myGroups") }),
]);

const ComparisonConditionSchema = Struct({
  left: ConditionPathSchema,
  op: ComparisonOpSchema,
  right: Union([ConditionPathSchema, ConditionValueSchema]),
});

type PatternOp = typeof PatternOpSchema.Type;

type Period = typeof PeriodSchema.Type;

type MembershipRight = typeof MembershipRightSchema.Type;

type RightSide = ConditionPath | ConditionValue;

/** A comparison of a path with a value or another path. */
export type ComparisonCondition = typeof ComparisonConditionSchema.Type;

/** A condition expression (Contracts 5.2). */
export type Condition =
  | { readonly op: "and" | "or"; readonly args: readonly Condition[] }
  | { readonly op: "not"; readonly arg: Condition }
  | { readonly op: "true" }
  | { readonly op: "false" }
  | ComparisonCondition
  | {
      readonly op: "in" | "notIn";
      readonly left: ConditionPath;
      readonly right: MembershipRight;
    }
  | { readonly op: "empty" | "notEmpty"; readonly arg: ConditionPath }
  | {
      readonly op: PatternOp;
      readonly left: ConditionPath;
      readonly right: string;
    }
  | {
      readonly op: "inPeriod";
      readonly left: ConditionPath;
      readonly period: Period;
    }
  | { readonly op: "changed"; readonly arg: ConditionPath };

/** The structural schema of a stored condition. */
export const ConditionSchema: Codec<Condition> = Union([
  Struct({
    args: SchemaArray(suspend((): Codec<Condition> => ConditionSchema)),
    op: Literals(["and", "or"]),
  }),
  Struct({
    arg: suspend((): Codec<Condition> => ConditionSchema),
    op: Literal("not"),
  }),
  Struct({ op: Literals(["true", "false"]) }),
  ComparisonConditionSchema,
  Struct({
    left: ConditionPathSchema,
    op: Literals(["in", "notIn"]),
    right: MembershipRightSchema,
  }),
  Struct({ arg: ConditionPathSchema, op: Literals(["empty", "notEmpty"]) }),
  Struct({
    left: ConditionPathSchema,
    op: PatternOpSchema,
    right: SchemaString,
  }),
  Struct({
    left: ConditionPathSchema,
    op: Literal("inPeriod"),
    period: PeriodSchema,
  }),
  Struct({ arg: ConditionPathSchema, op: Literal("changed") }),
]);

/**
 * Whether the right side of a comparison is a path.
 *
 * @param right - The right side.
 * @returns True for a path.
 */
const isPath = (right: RightSide): right is ConditionPath => "path" in right;

/**
 * Whether a condition compares a path with a value or a path.
 *
 * @param condition - A condition.
 * @returns True for `eq` to `ge`.
 */
const isComparison = (condition: Condition): condition is ComparisonCondition =>
  ComparisonOpSchema.literals.some((op) => op === condition.op);

/**
 * Every path a condition reads, in order of appearance.
 *
 * @param condition - A condition.
 * @returns The paths.
 */
export const conditionPaths = (
  condition: Condition
): readonly ConditionPath[] => {
  if (condition.op === "and" || condition.op === "or") {
    return condition.args.flatMap(conditionPaths);
  }

  if (condition.op === "not") {
    return conditionPaths(condition.arg);
  }

  if (isComparison(condition)) {
    return isPath(condition.right)
      ? [condition.left, condition.right]
      : [condition.left];
  }

  if ("arg" in condition) {
    return [condition.arg];
  }

  return "left" in condition ? [condition.left] : [];
};

/**
 * Every field ID a condition reads, deduplicated and sorted (for the
 * `condition_reads` dependency kind, Contracts 1.7).
 *
 * @param condition - A condition.
 * @returns The field IDs.
 */
export const conditionFieldIds = (
  condition: Condition
): readonly DefinitionId[] =>
  [...new Set(conditionPaths(condition).flatMap((path) => path.path))].toSorted(
    compareIds
  );
