/**
 * Stored conditions (Contracts 5.2), structurally.
 *
 * This module decodes the shape of a condition AST in a JSON-compatible
 * form (definitions are stored and compared as JSON) and lists the field
 * IDs it reads, for the `condition_reads` dependency kind. Field types,
 * operators, literals and profiles are checked by `@std/conditions`
 * (`condition-view.ts`) when a condition is stored.
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
  /**
   * `record`: the rule's own record (record-rule actions, Contracts 4.10);
   * `owner`: the owner, in the part conditions of aggregate rules (5.10).
   */
  scope: optionalKey(Literals(["record", "owner"])),
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
  | { readonly op: "changed"; readonly arg: ConditionPath }
  | {
      readonly op: "anyPart" | "allParts";
      readonly class: DefinitionId;
      readonly where: Condition;
    }
  | { readonly op: "partsChanged"; readonly class: DefinitionId };

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
  Struct({
    class: DefinitionIdSchema,
    op: Literals(["anyPart", "allParts"]),
    where: suspend((): Codec<Condition> => ConditionSchema),
  }),
  Struct({ class: DefinitionIdSchema, op: Literal("partsChanged") }),
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

  if (condition.op === "anyPart" || condition.op === "allParts") {
    return conditionPaths(condition.where);
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

const namedClasses = (condition: Condition): readonly DefinitionId[] => {
  if (condition.op === "and" || condition.op === "or") {
    return condition.args.flatMap(namedClasses);
  }

  if (condition.op === "not") {
    return namedClasses(condition.arg);
  }

  if (condition.op === "anyPart" || condition.op === "allParts") {
    return [condition.class, ...namedClasses(condition.where)];
  }

  return condition.op === "partsChanged" ? [condition.class] : [];
};

/**
 * Every class a condition names: the part classes of its `anyPart`,
 * `allParts` and `partsChanged` (aggregate record rules, Contracts 5.10),
 * deduplicated and sorted, for the `rule_on` dependency kind.
 *
 * @param condition - A condition.
 * @returns The class IDs.
 */
export const conditionClassIds = (
  condition: Condition
): readonly DefinitionId[] =>
  [...new Set(namedClasses(condition))].toSorted(compareIds);
