/**
 * What a record rule refers to (Contracts 1.7, 4.10), for the dependency
 * index and the set loader's order:
 *
 * - `classes`: its own class, every class an action names (`forEach`,
 *   `createEach`, `setParts`, `createParts`) and, for an `afterCommit`
 *   rule, its subscription (`rule_on` edges);
 * - `writes`: every field an action sets (`rule_writes`), so an active
 *   rule keeps the fields it writes from being retired;
 * - `reads`: every field its conditions read, every hop and record-scoped
 *   path included, and every field a value copies or increments, or an
 *   `updateEach` follows (`condition_reads`).
 */
import { conditionFieldIds } from "./condition.ts";
import type { Condition } from "./condition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import type {
  RuleAction,
  RuleAssignment,
  RuleForEach,
} from "./rule-definition.ts";

/** The parts of a rule that refer to other definitions. */
export interface ReferencingRule {
  readonly classId: DefinitionId;
  readonly condition: Condition | null;
  readonly actions: readonly RuleAction[];
  readonly subscriptionId: DefinitionId | null;
}

/** What a rule refers to, each list sorted and without duplicates. */
export interface RuleReferences {
  readonly classes: readonly DefinitionId[];
  readonly writes: readonly DefinitionId[];
  readonly reads: readonly DefinitionId[];
}

const sorted = (ids: Iterable<DefinitionId>): readonly DefinitionId[] =>
  [...new Set(ids)].toSorted(compareIds);

const conditionReads = (
  condition: Condition | null
): readonly DefinitionId[] =>
  condition === null ? [] : conditionFieldIds(condition);

const valueReads = (
  values: readonly RuleAssignment[]
): readonly DefinitionId[] =>
  values.flatMap(({ value }) => {
    if ("copy" in value) {
      return value.copy.fieldId === null ? [] : [value.copy.fieldId];
    }

    return "increment" in value ? [value.increment] : [];
  });

const forEachClasses = (
  forEach: RuleForEach | null
): readonly DefinitionId[] => (forEach === null ? [] : [forEach.classId]);

const forEachReads = (forEach: RuleForEach | null): readonly DefinitionId[] =>
  forEach === null ? [] : conditionReads(forEach.where);

const actionClasses = (action: RuleAction): readonly DefinitionId[] => {
  switch (action.type) {
    case "set":
    case "refuse": {
      return [];
    }

    case "setParts": {
      return [action.classId];
    }

    case "createParts":
    case "createEach": {
      return [action.classId, ...forEachClasses(action.forEach)];
    }

    case "updateEach": {
      return forEachClasses(action.forEach);
    }

    default: {
      return action satisfies never;
    }
  }
};

const actionReads = (action: RuleAction): readonly DefinitionId[] => {
  switch (action.type) {
    case "set": {
      return valueReads(action.values);
    }

    case "refuse": {
      return [];
    }

    case "setParts": {
      return [...conditionReads(action.where), ...valueReads(action.values)];
    }

    case "createParts":
    case "createEach": {
      return [...forEachReads(action.forEach), ...valueReads(action.values)];
    }

    case "updateEach": {
      return [
        ...forEachReads(action.forEach),
        ...(action.target === "self" ? [] : [action.target.via]),
        ...valueReads(action.values),
      ];
    }

    default: {
      return action satisfies never;
    }
  }
};

/**
 * The fields an action sets.
 *
 * @param action - An action.
 * @returns The field IDs; none for `refuse`.
 */
export const actionWrites = (action: RuleAction): readonly DefinitionId[] =>
  action.type === "refuse"
    ? []
    : action.values.map((assignment) => assignment.fieldId);

/**
 * What a rule refers to.
 *
 * @param rule - A record rule or its draft.
 * @returns Its classes, written fields and read fields.
 */
export const ruleReferences = (rule: ReferencingRule): RuleReferences => ({
  classes: sorted([
    rule.classId,
    ...rule.actions.flatMap(actionClasses),
    ...(rule.subscriptionId === null ? [] : [rule.subscriptionId]),
  ]),
  reads: sorted([
    ...conditionReads(rule.condition),
    ...rule.actions.flatMap(actionReads),
  ]),
  writes: sorted(rule.actions.flatMap(actionWrites)),
});
