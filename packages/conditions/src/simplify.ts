/**
 * Simplification of conditions sent to the browser (Contracts 5.10).
 *
 * Before the server sends a form rule to the browser it substitutes empty for
 * every field the caller can never read and folds constants, so the rule it
 * sends names no hidden field and form-rule outcomes reveal nothing about
 * hidden values. A path is empty when any field on it is hidden: a hidden
 * reference behaves like an empty reference. The rewrites follow Contracts
 * 5.4 for an empty left side:
 *
 * | Atom with an empty side | Becomes |
 * | --- | --- |
 * | `eq(f, v)`, `lt`..`ge`, `in`, pattern operators, `inPeriod`, `changed` | `false` |
 * | `ne(f, v)`, `notIn`, `notContains` | `true` |
 * | `empty(f)` / `notEmpty(f)` | `true` / `false` |
 * | `eq(f, g)` with one side empty | `empty(g)`; for booleans `notIn(g, [true, false])` |
 * | `eq(f, g)` with both sides empty | `true` |
 *
 * Constant folding then removes `true` from `and` and `false` from `or`,
 * collapses junctions holding the absorbing constant, unwraps one-element
 * junctions, negates constants under `not`, and turns `in(f, [])` and
 * `notIn(f, [])` into `false` and `true`. The result is equivalent to the
 * input for every record on which the hidden fields are empty.
 *
 * Booleans are never null in storage, but they read as empty when masked,
 * on a `previous` image at create, or through an empty reference, so the
 * simplifier keeps their null-aware meaning. `empty` does not apply to
 * booleans (Contracts 5.4), so "g is empty" is the single atom
 * `notIn(g, [true, false])` and its negation `in(g, [true, false])`, which
 * keeps the condition's depth.
 */
import {
  exprDepth,
  MAX_CONDITION_DEPTH,
  isCompare,
  isEmptyTest,
  isIn,
  isJunction,
  isMyGroups,
  isPath,
  isPatternTest,
} from "./ast.ts";
import type { Compare, Expr, Path } from "./ast.ts";
import type { ClassView, FieldInfo } from "./class-view.ts";
import { ConditionDefectError } from "./defect.ts";

/** What the simplifier knows about paths. */
interface Rules {
  /** Whether a path reads a hidden field (so its value is empty). */
  readonly hidden: (path: Path) => boolean;
  /** Whether a path reads a boolean, which has no `empty` operator. */
  readonly isBoolean: (path: Path) => boolean;
}

// "g is empty" for a boolean path g, or its negation, as one atom so the
// rewrite keeps the condition's depth: notIn(g, [true, false]) holds exactly
// when g is null, in(g, [true, false]) when it is not.
const booleanEmpty = (path: Path, negated: boolean): Expr => ({
  left: path,
  op: negated ? "in" : "notIn",
  right: [{ value: true }, { value: false }],
});

const TRUE: Expr = { op: "true" };
const FALSE: Expr = { op: "false" };

const constant = (value: boolean): Expr => (value ? TRUE : FALSE);

const isConstant = (expr: Expr, value: boolean): boolean =>
  expr.op === (value ? "true" : "false");

const foldJunction = (op: "and" | "or", args: readonly Expr[]): Expr => {
  const identity = op === "and";
  const kept = args.filter((arg) => !isConstant(arg, identity));

  if (kept.some((arg) => isConstant(arg, !identity))) {
    return constant(!identity);
  }

  if (kept.length === 0) {
    return constant(identity);
  }

  const [only] = kept;

  return kept.length === 1 && only !== undefined ? only : { args: kept, op };
};

const emptyCompare = (expr: Compare, rules: Rules): Expr | undefined => {
  const leftEmpty = rules.hidden(expr.left);
  const rightPath = isPath(expr.right) ? expr.right : undefined;
  const rightEmpty = rightPath !== undefined && rules.hidden(rightPath);

  if (!leftEmpty && !rightEmpty) {
    return undefined;
  }

  if (expr.op !== "eq" && expr.op !== "ne") {
    // Ordering with an empty side is false.
    return FALSE;
  }

  const negated = expr.op === "ne";

  if (rightPath === undefined || (leftEmpty && rightEmpty)) {
    // eq(empty, v) is false; eq(empty, empty) is true.
    return constant(rightPath === undefined ? negated : !negated);
  }

  const other = leftEmpty ? rightPath : expr.left;

  if (rules.isBoolean(other)) {
    return booleanEmpty(other, negated);
  }

  return { arg: other, op: negated ? "notEmpty" : "empty" };
};

const simplifyAtom = (expr: Expr, rules: Rules): Expr => {
  if (isCompare(expr)) {
    return emptyCompare(expr, rules) ?? expr;
  }

  if (isIn(expr)) {
    const isEmptyList = !isMyGroups(expr.right) && expr.right.length === 0;

    return rules.hidden(expr.left) || isEmptyList
      ? constant(expr.op === "notIn")
      : expr;
  }

  if (isEmptyTest(expr)) {
    return rules.hidden(expr.arg) ? constant(expr.op === "empty") : expr;
  }

  if (isPatternTest(expr)) {
    return rules.hidden(expr.left) ? constant(expr.op === "notContains") : expr;
  }

  if (expr.op === "inPeriod") {
    return rules.hidden(expr.left) ? FALSE : expr;
  }

  if (expr.op === "changed") {
    return rules.hidden(expr.arg) ? FALSE : expr;
  }

  return expr;
};

const simplify = (expr: Expr, rules: Rules): Expr => {
  if (isJunction(expr)) {
    return foldJunction(
      expr.op,
      expr.args.map((arg) => simplify(arg, rules))
    );
  }

  if (expr.op === "not") {
    const arg = simplify(expr.arg, rules);

    if (arg.op === "true" || arg.op === "false") {
      return constant(arg.op === "false");
    }

    return { arg, op: "not" };
  }

  return simplifyAtom(expr, rules);
};

/** What `simplifyForCaller` needs. */
export interface SimplifyOptions {
  /**
   * Whether the caller can never read a field. Field IDs are globally
   * unique, so the predicate applies on every hop.
   */
  readonly isHidden: (fieldId: string) => boolean;
  /** The view the condition was checked against, to find field types. */
  readonly view: ClassView;
  /** The condition's class. */
  readonly classId: string;
}

const readsBoolean = (options: SimplifyOptions, path: Path): boolean => {
  let { classId } = options;
  let field: FieldInfo | undefined;

  for (const id of path.path) {
    if (field?.type.kind === "reference") {
      classId = field.type.targetClassId;
    }

    field = options.view.field(classId, id);
  }

  return field?.type.kind === "boolean";
};

/**
 * Substitutes empty for hidden fields and folds constants.
 *
 * @param expr - The condition.
 * @param options - Which fields are hidden, and the view and class.
 * @returns An equivalent condition (for records where hidden fields are
 *   empty) that names no hidden field.
 */
export const simplifyForCaller = (
  expr: Expr,
  options: SimplifyOptions
): Expr => {
  if (exprDepth(expr) > MAX_CONDITION_DEPTH) {
    throw new ConditionDefectError(
      "Simplify only conditions that passed the checker."
    );
  }

  return simplify(expr, {
    hidden: (path) => path.path.some((id) => options.isHidden(id)),
    isBoolean: (path) => readsBoolean(options, path),
  });
};

/**
 * Folds constants only.
 *
 * @param expr - The condition.
 * @returns An equivalent condition with constants folded.
 */
export const foldConstants = (expr: Expr): Expr => {
  if (exprDepth(expr) > MAX_CONDITION_DEPTH) {
    throw new ConditionDefectError(
      "Fold only conditions that passed the checker."
    );
  }

  return simplify(expr, { hidden: () => false, isBoolean: () => false });
};
