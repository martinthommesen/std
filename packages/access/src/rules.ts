/**
 * Which access rules apply (Contracts 3.2), and the decisions they give.
 *
 * A rule applies to caller u, action a and a record of concrete class C
 * when it is active, names a role u holds, includes a, is attached to C, an
 * ancestor of C or `*`, and has a matching target. Its condition decides
 * per record; the decision combines them (`decision.ts`).
 *
 * Field targets: a list names fields by ID; `*` on class T covers the
 * fields of T and its ancestors, never fields added by descendants
 * (Contracts 3.2), and `*` on every class (`*`) covers every field.
 *
 * Nothing here looks at a role's name: roles are IDs, and the caller's
 * effective role IDs (with `authenticated` for an active user) come from
 * the server.
 */
import { decodeExpr } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import type {
  AccessAction,
  AccessRuleDefinition,
} from "@std/definitions/definition";
import { isActive } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonValue } from "@std/values/json-value";
import { Result } from "effect";

import { combine } from "./decision.ts";
import type { Decision, RuleCondition } from "./decision.ts";

/** Who asks: the caller's effective role IDs. */
export interface Caller {
  /**
   * Every role the caller holds, `authenticated` included for an active
   * user; empty for a deactivated one (Contracts 3.10).
   */
  readonly roleIds: readonly DefinitionId[];
}

/** The actions a field rule may name (field rules cannot use delete). */
export type FieldAction = Exclude<AccessAction, "delete">;

/** A stored condition that does not decode never grants and always denies. */
const UNREADABLE_CONDITION: Expr = { op: "false" };

const conditionOf = (rule: AccessRuleDefinition): RuleCondition => {
  if (rule.condition === null) {
    return undefined;
  }

  const json: JsonValue = rule.condition;
  const decoded = decodeExpr(json);

  if (Result.isSuccess(decoded)) {
    return decoded.success;
  }

  // Stored conditions were checked when they were written; a condition that
  // still does not decode must not widen access.
  return rule.effect === "allow" ? UNREADABLE_CONDITION : undefined;
};

const holdsRole = (caller: Caller, rule: AccessRuleDefinition): boolean => {
  const held = new Set(caller.roleIds);

  return rule.roleIds.some((roleId) => held.has(roleId));
};

/**
 * Whether a rule is in force for the caller at all.
 *
 * @param caller - The caller's roles.
 * @param rule - A rule.
 * @returns True for an active rule naming a role the caller holds.
 */
const inForce = (caller: Caller, rule: AccessRuleDefinition): boolean =>
  rule.active && isActive(rule) && holdsRole(caller, rule);

const attachedTo = (
  snapshot: ConfigSnapshot,
  rule: AccessRuleDefinition,
  classId: DefinitionId
): boolean =>
  rule.classId === null ||
  snapshot.lineage(classId).some((level) => level.id === rule.classId);

const appliesTo = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  rule: AccessRuleDefinition,
  action: AccessAction,
  classId: DefinitionId
): boolean =>
  inForce(caller, rule) &&
  rule.actions.includes(action) &&
  attachedTo(snapshot, rule, classId);

/**
 * Whether a field rule's target covers a field.
 *
 * @param snapshot - The configuration.
 * @param rule - A rule with a `fields` target.
 * @param fieldId - The field.
 * @returns True when the list names it, or `*` covers it.
 */
const coversField = (
  snapshot: ConfigSnapshot,
  rule: AccessRuleDefinition,
  fieldId: DefinitionId
): boolean => {
  if (rule.target.kind !== "fields") {
    return false;
  }

  if (rule.target.fields !== "*") {
    return rule.target.fields.includes(fieldId);
  }

  if (rule.classId === null) {
    return true;
  }

  const field = snapshot.field(fieldId);

  return (
    field !== undefined &&
    snapshot.lineage(rule.classId).some((level) => level.id === field.classId)
  );
};

/**
 * The record rules that apply to a caller, an action and a concrete class.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - The action.
 * @param classId - The record's concrete class.
 * @returns The rules, sorted by ID.
 */
export const recordRules = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: AccessAction,
  classId: DefinitionId
): readonly AccessRuleDefinition[] =>
  snapshot
    .accessRules()
    .filter(
      (rule) =>
        rule.target.kind === "records" &&
        appliesTo(snapshot, caller, rule, action, classId)
    );

/**
 * The field rules that apply to a caller, an action, a concrete class and
 * one of its fields.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - Read, create or update.
 * @param classId - The record's concrete class.
 * @param fieldId - A field of the class or an ancestor.
 * @returns The rules, sorted by ID.
 */
export const fieldRules = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: FieldAction,
  classId: DefinitionId,
  fieldId: DefinitionId
): readonly AccessRuleDefinition[] =>
  snapshot
    .accessRules()
    .filter(
      (rule) =>
        appliesTo(snapshot, caller, rule, action, classId) &&
        coversField(snapshot, rule, fieldId)
    );

const decide = (rules: readonly AccessRuleDefinition[]): Decision => {
  const allows: RuleCondition[] = [];
  const denies: RuleCondition[] = [];

  for (const rule of rules) {
    (rule.effect === "allow" ? allows : denies).push(conditionOf(rule));
  }

  return combine(allows, denies);
};

/**
 * The record-level decision: row visibility for `read`, and the record
 * check of a create, update or delete (Contracts 3.2, 3.9).
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - The action.
 * @param classId - The record's concrete class.
 * @returns Never, always or the condition.
 */
export const recordDecision = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: AccessAction,
  classId: DefinitionId
): Decision => decide(recordRules(snapshot, caller, action, classId));

/**
 * The field-level decision for one field of a concrete class (Contracts
 * 3.2, 3.4). Reading a field also needs the record decision, which every
 * read applies as row visibility; writes check both.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - Read, create or update.
 * @param classId - The record's concrete class.
 * @param fieldId - A field of the class or an ancestor.
 * @returns Never, always or the condition.
 */
export const fieldDecision = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: FieldAction,
  classId: DefinitionId,
  fieldId: DefinitionId
): Decision => decide(fieldRules(snapshot, caller, action, classId, fieldId));

/**
 * Whether any of the caller's roles has any allow that reaches records of
 * a class: a rule on `*`, on the class or an ancestor, or on a descendant
 * (whose records the class's endpoint lists). Otherwise the table is
 * unknown to the caller, exactly like a table that does not exist
 * (Contracts 3.4).
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param classId - The endpoint's class.
 * @returns True when the caller may name the table.
 */
export const knowsTable = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId
): boolean => {
  const reach = new Set<DefinitionId>([
    ...snapshot.lineage(classId).map((level) => level.id),
    ...snapshot.subtreeIds(classId),
  ]);

  return snapshot
    .accessRules()
    .some(
      (rule) =>
        rule.effect === "allow" &&
        inForce(caller, rule) &&
        (rule.classId === null || reach.has(rule.classId))
    );
};
