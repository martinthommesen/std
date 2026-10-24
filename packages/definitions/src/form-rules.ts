/** Form-only field state and deterministic inheritance (Contracts 5.10, decision 0036). */
import { isBoolean } from "@std/values/field-value";

import { conditionProblems } from "./condition-view.ts";
import type { ConditionPurpose } from "./condition-view.ts";
import type { FormRuleDefinition } from "./definition.ts";
import { compareIds } from "./ids.ts";
import { identifierProblem } from "./names.ts";
import { problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

const rulesBySnapshot = new WeakMap<
  ConfigSnapshot,
  Map<string, readonly FormRuleDefinition[]>
>();

/**
 * Rules inherited by a concrete class, ordered globally by order then ID.
 * @param snapshot - The effective configuration.
 * @param classId - The concrete class.
 * @returns Active inherited rules in their deterministic execution order.
 */
export const formRulesOf = (
  snapshot: ConfigSnapshot,
  classId: string
): readonly FormRuleDefinition[] => {
  let byClass = rulesBySnapshot.get(snapshot);

  if (byClass === undefined) {
    byClass = new Map();
    rulesBySnapshot.set(snapshot, byClass);
  }

  const known = byClass.get(classId);

  if (known !== undefined) {
    return known;
  }

  const lineage = new Set(snapshot.lineage(classId).map((entry) => entry.id));

  const rules = snapshot
    .all("formRule")
    .filter(
      (rule) =>
        rule.active && rule.state === "active" && lineage.has(rule.classId)
    )
    .toSorted(
      (left, right) => left.order - right.order || compareIds(left.id, right.id)
    );

  byClass.set(classId, rules);

  return rules;
};

const assignmentProblem = (
  snapshot: ConfigSnapshot,
  rule: FormRuleDefinition
): DefinitionProblem | undefined => {
  const field = snapshot.field(rule.fieldId);
  const choiceAssignment = rule.property === "choices";

  const keys = new Set(
    snapshot.choicesOf(rule.fieldId).map((choice) => choice.key)
  );

  const validValue = isBoolean(rule.value)
    ? !choiceAssignment
    : choiceAssignment &&
      field?.type.kind === "choice" &&
      rule.value.every((key) => keys.has(key));

  const noClear = rule.clearHidden === undefined || rule.clearHidden === null;

  const clearable =
    rule.property === "hidden" &&
    rule.value === true &&
    field?.type.kind === "boolean";

  const validClear = noClear || clearable;

  if (!validValue || !validClear) {
    return problem(
      "invalidFormRule",
      rule.id,
      "Boolean states need a boolean; choices need known choice keys; clearing a hidden field requires a hidden boolean."
    );
  }

  return undefined;
};

/** Validates a form rule against its class and the browser condition profile.
 * @param snapshot - The effective configuration.
 * @param rule - The form rule.
 * @param purpose - Whether its condition is being stored or evaluated.
 * @returns All definition problems.
 */
export const formRuleProblems = (
  snapshot: ConfigSnapshot,
  rule: FormRuleDefinition,
  purpose: ConditionPurpose
): readonly DefinitionProblem[] => {
  const problems: DefinitionProblem[] = [];
  const host = snapshot.class(rule.classId);

  const field = snapshot
    .fields(rule.classId)
    .find((entry) => entry.id === rule.fieldId);

  const invalidName = identifierProblem(rule.name);

  const usableClass =
    host !== undefined &&
    host.state !== "purged" &&
    host.storage !== "platform";

  const usableField = field !== undefined && field.state !== "purged";
  const retiredTarget = purpose === "store" && field?.state !== "active";

  if (!usableClass || !usableField || retiredTarget) {
    problems.push(
      problem(
        "invalidFormRule",
        rule.id,
        "A form rule needs a live ordinary class and a field of its lineage."
      )
    );
  }

  if (invalidName !== undefined) {
    problems.push(
      problem(
        "invalidName",
        rule.id,
        "A form rule needs a valid identifier name."
      )
    );
  }

  const assignment = assignmentProblem(snapshot, rule);

  if (assignment !== undefined) {
    problems.push(assignment);
  }

  if (rule.condition !== null) {
    for (const message of conditionProblems(
      snapshot,
      rule.classId,
      rule.condition,
      "formRule",
      purpose
    )) {
      problems.push(problem("invalidCondition", rule.id, message));
    }
  }

  return problems;
};
