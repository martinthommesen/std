/**
 * Which record rules apply to a save (Contracts 4.1, 4.10): those attached
 * to the record's concrete class and to every ancestor, whichever endpoint
 * the save came through; active (the overridable flag) and not retired;
 * of the phase (and `before` kind) asked for; listing the operation. They
 * run in rule order: order number, then stable ID, across the lineage.
 */
import type { RecordRuleDefinition } from "@std/definitions/definition";
import { isActive } from "@std/definitions/definition";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type {
  RuleKind,
  RuleOperation,
  RulePhase,
} from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

/** What a selection asks for. */
export interface RuleSelection {
  readonly phase: RulePhase;
  /** The save's operation; omitted for `aggregate`, which lists none. */
  readonly operation?: RuleOperation;
  /** A `before` kind. */
  readonly kind?: RuleKind;
}

/**
 * Whether a rule runs: active and not retired, of the phase and kind,
 * listing the operation.
 *
 * @param rule - A live rule.
 * @param selection - Phase, operation and kind.
 * @returns True when selected.
 */
const isSelected = (
  rule: RecordRuleDefinition,
  selection: RuleSelection
): boolean => {
  const running = rule.active && isActive(rule);

  const kindFits =
    selection.kind === undefined || rule.ruleKind === selection.kind;

  const operationFits =
    selection.operation === undefined ||
    rule.operations.includes(selection.operation);

  return running && rule.phase === selection.phase && kindFits && operationFits;
};

/**
 * Orders rules: order number, then stable ID.
 *
 * @param left - A rule.
 * @param right - Another rule.
 * @returns Negative when `left` runs first.
 */
export const compareRules = (
  left: RecordRuleDefinition,
  right: RecordRuleDefinition
): number => left.order - right.order || compareIds(left.id, right.id);

/**
 * The rules that run on a record of a concrete class, in rule order.
 *
 * @param snapshot - The request's configuration.
 * @param classId - The record's concrete class.
 * @param selection - Phase, operation and `before` kind.
 * @returns The rules.
 */
export const selectRules = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  selection: RuleSelection
): readonly RecordRuleDefinition[] => {
  const selected: RecordRuleDefinition[] = [];

  for (const level of snapshot.lineage(classId)) {
    for (const rule of snapshot.recordRulesOf(level.id)) {
      if (isSelected(rule, selection)) {
        selected.push(rule);
      }
    }
  }

  return selected.toSorted(compareRules);
};
