/**
 * The internal trees the engine works on.
 *
 * - A {@link CheckedCondition} is what `checkCondition` returns: every path
 *   resolved to its fields, every literal converted under its field type
 *   (`ComparableValue`), and the negated operators (`ne`, `notIn`,
 *   `notContains`, `notEmpty`) written as `not` of their positive forms, as
 *   Contracts 5.2 defines them. Context values, relative dates and
 *   `inPeriod` are still symbolic.
 * - A {@link ResolvedCondition} is what `resolveCondition` returns: context
 *   values and relative dates are literals, `inPeriod` is `ge and lt`, and a
 *   context value the caller did not provide is `unavailable` (the browser
 *   evaluator turns it into Unknown; the server evaluator and the SQL
 *   compiler refuse it as a defect).
 */
import type { ComparableValue } from "@std/values/compare";

import type {
  NowUnit,
  PatternOperatorName,
  PeriodUnit,
  TodayUnit,
} from "./ast.ts";
import type { FieldInfo } from "./class-view.ts";

/** A path with every field it crosses. */
export interface TypedPath {
  /** The field IDs, as in the AST. */
  readonly ids: readonly string[];
  /** Which image the first hop reads. */
  readonly image: "current" | "previous";
  /**
   * One entry per ID: the reference fields crossed, then the field read.
   * `fields[i]` is resolved on `classes[i]`.
   */
  readonly fields: readonly FieldInfo[];
  /** The class each ID is resolved on: the record's class, then targets. */
  readonly classes: readonly string[];
  /** The field read (the last entry of `fields`). */
  readonly field: FieldInfo;
}

/** A comparison operator after `ne` became `not eq`. */
export type PositiveCompare = "eq" | "lt" | "le" | "gt" | "ge";

/** A pattern operator after `notContains` became `not contains`. */
export type PositivePattern = Exclude<PatternOperatorName, "notContains">;

/** A right-hand side in a checked condition. */
export type CheckedOperand =
  | { readonly kind: "path"; readonly path: TypedPath }
  | { readonly kind: "literal"; readonly value: ComparableValue }
  | { readonly kind: "me" }
  | { readonly kind: "now" }
  | {
      readonly kind: "relNow";
      readonly unit: NowUnit;
      readonly offset: number;
    }
  | {
      readonly kind: "relToday";
      readonly unit: TodayUnit;
      readonly offset: number;
    }
  | { readonly kind: "myGroups" };

/** A right-hand side in a resolved condition. */
export type ResolvedOperand =
  | { readonly kind: "path"; readonly path: TypedPath }
  | { readonly kind: "literal"; readonly value: ComparableValue }
  | { readonly kind: "unavailable" };

/** A period test, present only before resolution. */
export interface InPeriodNode {
  readonly op: "inPeriod";
  readonly left: TypedPath;
  readonly unit: PeriodUnit;
  readonly offset: number;
}

/** The nodes of checked and resolved conditions; `Extra` adds node kinds. */
export type Node<Operand, Extra = never> =
  | {
      readonly op: "and" | "or";
      readonly args: readonly Node<Operand, Extra>[];
    }
  | { readonly op: "not"; readonly arg: Node<Operand, Extra> }
  | { readonly op: "const"; readonly value: boolean }
  | {
      readonly op: "compare";
      readonly compare: PositiveCompare;
      readonly left: TypedPath;
      readonly right: Operand;
    }
  | {
      readonly op: "in";
      readonly left: TypedPath;
      readonly right: readonly Operand[];
    }
  | { readonly op: "empty"; readonly arg: TypedPath }
  | {
      readonly op: "pattern";
      readonly pattern: PositivePattern;
      readonly left: TypedPath;
      /** The needle after steps 1 and 2 of Contracts 5.5 (not folded). */
      readonly needle: string;
    }
  | { readonly op: "changed"; readonly arg: TypedPath }
  | Extra;

/** A node of a checked condition. */
export type CheckedNode = Node<CheckedOperand, InPeriodNode>;

/** A node of a resolved condition: no `inPeriod`. */
export type ResolvedNode = Node<ResolvedOperand>;

/** A condition that passed the checker. */
export interface CheckedCondition {
  readonly stage: "checked";
  readonly classId: string;
  readonly root: CheckedNode;
}

/** A checked condition with context and relative dates resolved. */
export interface ResolvedCondition {
  readonly stage: "resolved";
  readonly classId: string;
  readonly root: ResolvedNode;
}

/**
 * Wraps a checked tree. Used by the checker.
 *
 * @param classId - The class the condition was checked against.
 * @param root - The checked tree.
 * @returns The branded condition.
 */
export const makeChecked = (
  classId: string,
  root: CheckedNode
): CheckedCondition => ({
  classId,
  root,
  stage: "checked",
});

/**
 * Wraps a resolved tree. Used by the resolver.
 *
 * @param classId - The class.
 * @param root - The resolved tree.
 * @returns The branded condition.
 */
export const makeResolved = (
  classId: string,
  root: ResolvedNode
): ResolvedCondition => ({
  classId,
  root,
  stage: "resolved",
});

/**
 * A stable key for a path's join prefix: the image and the first `length`
 * IDs.
 *
 * @param path - The typed path.
 * @param length - How many IDs the prefix holds.
 * @returns A key such as `current:<id>/<id>`.
 */
export const prefixKey = (path: TypedPath, length: number): string =>
  `${path.image}:${path.ids.slice(0, length).join("/")}`;
