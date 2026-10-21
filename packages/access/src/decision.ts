/**
 * Decisions (Contracts 3.2, 3.4): the outcome of the access rules that apply
 * to one caller, one action and one concrete class, for the record or for
 * one field.
 *
 * - `never`: no applicable allow, or an unconditional deny.
 * - `always`: an unconditional allow and no deny.
 * - `conditional`: (OR of allow conditions) AND NOT (OR of deny
 *   conditions), as a condition AST in the access-rule profile. The server
 *   checks, resolves and compiles it with `@std/conditions`.
 *
 * A decision depends on the record and the caller only, never on the
 * endpoint: it is computed per concrete class.
 */
import type { Expr } from "@std/conditions/ast";

/** The outcome of the applicable rules. */
export type Decision =
  | { readonly kind: "never" }
  | { readonly kind: "always" }
  | { readonly kind: "conditional"; readonly condition: Expr };

/** No applicable allow, or an unconditional deny. */
export const NEVER: Decision = { kind: "never" };

/** An unconditional allow and no deny. */
export const ALWAYS: Decision = { kind: "always" };

/**
 * One applicable rule's condition: `undefined` for a rule without one,
 * which holds for every record.
 */
export type RuleCondition = Expr | undefined;

const orOf = (conditions: readonly Expr[]): Expr =>
  conditions.length === 1 && conditions[0] !== undefined
    ? conditions[0]
    : { args: conditions, op: "or" };

/**
 * Combines the applicable rules (Contracts 3.2): any applicable deny
 * refuses, otherwise any applicable allow grants, otherwise refused.
 *
 * @param allows - Conditions of the applicable allow rules, in rule ID order.
 * @param denies - Conditions of the applicable deny rules, in rule ID order.
 * @returns The decision.
 */
export const combine = (
  allows: readonly RuleCondition[],
  denies: readonly RuleCondition[]
): Decision => {
  if (allows.length === 0 || denies.includes(undefined)) {
    return NEVER;
  }

  const denyConditions = denies.filter(
    (condition): condition is Expr => condition !== undefined
  );

  const allowConditions = allows.includes(undefined)
    ? []
    : allows.filter((condition): condition is Expr => condition !== undefined);

  if (allowConditions.length === 0 && denyConditions.length === 0) {
    return ALWAYS;
  }

  const notDenied: Expr | undefined =
    denyConditions.length === 0
      ? undefined
      : { arg: orOf(denyConditions), op: "not" };

  if (allowConditions.length === 0) {
    return notDenied === undefined
      ? ALWAYS
      : { condition: notDenied, kind: "conditional" };
  }

  const allowed = orOf(allowConditions);

  return {
    condition:
      notDenied === undefined
        ? allowed
        : { args: [allowed, notDenied], op: "and" },
    kind: "conditional",
  };
};

/**
 * A key that is equal for equal decisions, to group classes that share one
 * predicate (Contracts 3.5).
 *
 * @param decision - A decision.
 * @returns `never`, `always` or the condition's JSON.
 */
export const decisionKey = (decision: Decision): string =>
  decision.kind === "conditional"
    ? `conditional:${JSON.stringify(decision.condition)}`
    : decision.kind;

/**
 * Both decisions at once (for reading a field: record read and field read).
 *
 * @param left - A decision.
 * @param right - Another decision.
 * @returns `left AND right`.
 */
export const both = (left: Decision, right: Decision): Decision => {
  if (left.kind === "never" || right.kind === "never") {
    return NEVER;
  }

  if (left.kind === "always") {
    return right;
  }

  if (right.kind === "always") {
    return left;
  }

  return {
    condition: { args: [left.condition, right.condition], op: "and" },
    kind: "conditional",
  };
};
