/**
 * Definition validation of record rules (Contracts 4.10, 5.10, decision
 * 0022). Every illegal combination of phase, kind, action, `once`,
 * `runAs`, subscription and operations is a `DefinitionInvalid` problem
 * (`invalidRecordRule`), and every condition is checked in the record-rule
 * profile (`invalidCondition`).
 *
 * | Phase | `ruleKind` | Actions | `operations` | `once` | `runAsId` | `subscriptionId` |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | `before` | required: `derive` (only `set`, never `delete`), `guard` or `invariant` (only `refuse`) | `set`, `refuse` | at least one | false | null | null |
 * | `after` | null | `updateEach`, `createEach` | at least one | false | optional | null |
 * | `afterCommit` | null | `updateEach`, `createEach` | at least one | false | null | required |
 * | `aggregate` | null | `set`, `refuse`, `setParts`, `createParts` | none | optional | null | null |
 *
 * Values are checked against the field they set: a literal must convert
 * under its type (a choice must name a live choice), `now` fits date-time
 * fields, `me` a reference to users or a uuid, a copy a field of the same
 * kind (a reference to the same class or a descendant), an increment an
 * integer field. `copy` from `source` needs a `forEach`; from `owner` the
 * `aggregate` phase. Fields set by `updateEach` and `createEach` (nested
 * saves through the pipeline) must be writable: neither read-only nor
 * auto-numbered. An auto-numbered field is never set. A `forEach.where`
 * reads the `forEach` class and, through `scope: "record"` paths, the
 * rule's record; it cannot use `changed` or `previous`, since the records
 * it selects are not being saved.
 */
import { decodeIn } from "@std/values/codec";
import type { FieldKind, FieldType } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";

import { conditionProblems } from "./condition-view.ts";
import type { ConditionPurpose } from "./condition-view.ts";
import { conditionPaths } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type {
  FieldDefinition,
  RecordRuleDefinition,
  SubscriptionDefinition,
} from "./definition.ts";
import { isActive, isLive } from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import { identifierProblem } from "./names.ts";
import { PermissionRequired } from "./permission-required.ts";
import { problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import { hasPermission } from "./requester.ts";
import type { Requester } from "./requester.ts";
import { KIND_ACTIONS, PHASE_ACTIONS } from "./rule-definition.ts";
import type {
  RuleAction,
  RuleAssignment,
  RuleForEach,
  RuleValue,
} from "./rule-definition.ts";
import type { ConfigSnapshot } from "./snapshot.ts";
import { PERMISSION_IDS, USER_CLASS_ID } from "./well-known.ts";

/** The longest fixed message a `refuse` action may carry. [judgment] */
export const REFUSAL_MESSAGE_MAX = 500;

interface Checking {
  readonly snapshot: ConfigSnapshot;
  readonly rule: RecordRuleDefinition;
  readonly purpose: ConditionPurpose;
  readonly problems: DefinitionProblem[];
}

/** Where the values of one action are set, and what they may read. */
interface ValueScope {
  /** The class whose fields the action sets. */
  readonly targetClassId: DefinitionId;
  /** The `forEach` class, for `copy` from `source`; null without one. */
  readonly sourceClassId: DefinitionId | null;
  /** Whether the values are a nested save's body (`after`, `afterCommit`). */
  readonly nestedSave: boolean;
  /** Where in the rule the action is, for messages. */
  readonly at: string;
}

const invalid = (checking: Checking, message: string): void => {
  checking.problems.push(
    problem("invalidRecordRule", checking.rule.id, message)
  );
};

const conditionAt = (
  checking: Checking,
  at: string,
  messages: readonly string[]
): void => {
  for (const message of messages) {
    checking.problems.push(
      problem("invalidCondition", checking.rule.id, `${at}: ${message}`)
    );
  }
};

/**
 * Whether a class exists, is live and records go through the record
 * service (not a platform table).
 *
 * @param checking - The rule being checked; a problem is recorded there.
 * @param classId - The class.
 * @param role - What the class is to the rule, for messages.
 * @returns True when usable.
 */
const usableClass = (
  checking: Checking,
  classId: DefinitionId,
  role: string
): boolean => {
  const found = checking.snapshot.get(classId);

  if (found?.kind !== "class" || !isLive(found)) {
    invalid(checking, `Its ${role} ${classId} is not a live class.`);

    return false;
  }

  if (found.storage === "platform") {
    invalid(
      checking,
      `Its ${role} ${classId} is a platform table, whose rows are not saved through the record service.`
    );

    return false;
  }

  return true;
};

const fieldOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  fieldId: DefinitionId
): FieldDefinition | undefined =>
  snapshot.fields(classId).find((field) => field.id === fieldId);

/**
 * Whether `classId` is `ancestorId` or one of its descendants.
 *
 * @param snapshot - The configuration.
 * @param classId - A class.
 * @param ancestorId - The class it should extend.
 * @returns True when it is one.
 */
const isA = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  ancestorId: DefinitionId
): boolean =>
  snapshot.lineage(classId).some((entry) => entry.id === ancestorId);

const INTEGER_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "integer",
  "bigInteger",
]);

const WRITE_ONLY_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "password",
  "secret",
]);

const literalProblem = (
  snapshot: ConfigSnapshot,
  field: FieldDefinition,
  json: JsonValue
): string | undefined => {
  if (!decodeIn(field.type, json).ok) {
    return "is not a valid value of its field";
  }

  if (field.type.kind !== "choice" || json === null) {
    return undefined;
  }

  const live = snapshot
    .choicesOf(field.id)
    .some((choice) => choice.key === json && !choice.hidden);

  return live ? undefined : "names no live choice of its field";
};

const sameKind = (
  snapshot: ConfigSnapshot,
  source: FieldType,
  target: FieldType
): boolean => {
  if (source.kind === "reference" && target.kind === "reference") {
    return isA(snapshot, source.targetClassId, target.targetClassId);
  }

  return source.kind === target.kind;
};

// A copy of a record's ID: only into a nested save's body (a `before`
// rule's record has no ID yet on create), into a uuid field or a
// reference to the record's class or an ancestor.
const idCopyProblem = (
  checking: Checking,
  scope: ValueScope,
  classId: DefinitionId,
  target: FieldDefinition
): string | undefined => {
  if (!scope.nestedSave) {
    return "copies a record's ID, which only updateEach and createEach set";
  }

  const fits =
    target.type.kind === "uuid" ||
    (target.type.kind === "reference" &&
      isA(checking.snapshot, classId, target.type.targetClassId));

  return fits
    ? undefined
    : "copies a record's ID into a field that cannot reference it";
};

const copyProblem = (
  checking: Checking,
  scope: ValueScope,
  value: Extract<RuleValue, { readonly copy: unknown }>,
  target: FieldDefinition
): string | undefined => {
  const { from, fieldId } = value.copy;

  if (from === "owner") {
    return checking.rule.phase === "aggregate"
      ? undefined
      : "copies from the owner, which only aggregate rules read";
  }

  const classId =
    from === "record" ? checking.rule.classId : scope.sourceClassId;

  if (classId === null) {
    return "copies from source, but its action has no forEach";
  }

  if (fieldId === null) {
    return idCopyProblem(checking, scope, classId, target);
  }

  const source = fieldOf(checking.snapshot, classId, fieldId);

  if (source === undefined) {
    return `copies ${fieldId}, which is not a field of its ${from}`;
  }

  if (
    WRITE_ONLY_KINDS.has(source.type.kind) ||
    WRITE_ONLY_KINDS.has(target.type.kind)
  ) {
    return "copies a password or secret, which rules never read";
  }

  return sameKind(checking.snapshot, source.type, target.type)
    ? undefined
    : "copies a field of another type";
};

const valueProblem = (
  checking: Checking,
  scope: ValueScope,
  field: FieldDefinition,
  value: RuleValue
): string | undefined => {
  if ("value" in value) {
    return literalProblem(checking.snapshot, field, value.value);
  }

  if ("ctx" in value) {
    if (value.ctx === "now") {
      return field.type.kind === "dateTime"
        ? undefined
        : "uses now, which only date-time fields take";
    }

    const fits =
      field.type.kind === "uuid" ||
      (field.type.kind === "reference" &&
        isA(checking.snapshot, USER_CLASS_ID, field.type.targetClassId));

    return fits ? undefined : "uses me, which only user references take";
  }

  if ("copy" in value) {
    return copyProblem(checking, scope, value, field);
  }

  const source = fieldOf(
    checking.snapshot,
    checking.rule.classId,
    value.increment
  );

  return source !== undefined &&
    INTEGER_KINDS.has(source.type.kind) &&
    INTEGER_KINDS.has(field.type.kind)
    ? undefined
    : "increments a field that is not an integer field of the rule's record";
};

const checkAssignment = (
  checking: Checking,
  scope: ValueScope,
  assignment: RuleAssignment
): void => {
  const field = fieldOf(
    checking.snapshot,
    scope.targetClassId,
    assignment.fieldId
  );

  const where = `${scope.at}: the value of ${assignment.fieldId}`;

  if (field === undefined) {
    invalid(checking, `${where} is not a field of the class it sets.`);

    return;
  }

  if (checking.purpose === "store" && !isActive(field)) {
    invalid(checking, `${where} sets a retired field.`);
  }

  if (field.numberPrefix !== null) {
    invalid(checking, `${where} sets an auto-numbered field.`);
  } else if (scope.nestedSave && field.readOnly) {
    invalid(
      checking,
      `${where} sets a read-only field, which a nested save cannot write.`
    );
  }

  const found = valueProblem(checking, scope, field, assignment.value);

  if (found !== undefined) {
    invalid(checking, `${where} ${found}.`);
  }
};

const checkValues = (
  checking: Checking,
  scope: ValueScope,
  values: readonly RuleAssignment[]
): void => {
  if (values.length === 0) {
    invalid(checking, `${scope.at} sets no field.`);
  }

  const seen = new Set<DefinitionId>();

  for (const assignment of values) {
    if (seen.has(assignment.fieldId)) {
      invalid(checking, `${scope.at} sets ${assignment.fieldId} twice.`);
    }

    seen.add(assignment.fieldId);
    checkAssignment(checking, scope, assignment);
  }
};

const usesChange = (condition: Condition): boolean => {
  if (condition.op === "and" || condition.op === "or") {
    return condition.args.some(usesChange);
  }

  if (condition.op === "not") {
    return usesChange(condition.arg);
  }

  return condition.op === "changed";
};

/**
 * Checks a condition on the records an action selects or changes:
 * `forEach.where`, `setParts.where`.
 *
 * @param checking - The rule being checked.
 * @param classId - The class the condition reads.
 * @param condition - The condition, or null.
 * @param at - Where it is, for messages.
 */
const checkSelection = (
  checking: Checking,
  classId: DefinitionId,
  condition: Condition | null,
  at: string
): void => {
  if (condition === null) {
    return;
  }

  const previous = conditionPaths(condition).some(
    (path) => path.image === "previous"
  );

  if (previous || usesChange(condition)) {
    invalid(
      checking,
      `${at} cannot use changed or previous: the records it selects are not being saved.`
    );
  }

  // The selection compiles to SQL over the class's own relation, which
  // joins no reference target. [judgment, decision 0022]
  const hops = conditionPaths(condition).some(
    (path) => path.scope === undefined && path.path.length > 1
  );

  if (hops) {
    invalid(checking, `${at} follows no reference: name fields of its class.`);
  }

  conditionAt(
    checking,
    at,
    conditionProblems(
      checking.snapshot,
      classId,
      condition,
      "recordRule",
      checking.purpose,
      checking.rule.classId
    )
  );
};

const checkForEach = (
  checking: Checking,
  forEach: RuleForEach,
  at: string
): boolean => {
  if (!usableClass(checking, forEach.classId, `${at} forEach class`)) {
    return false;
  }

  checkSelection(checking, forEach.classId, forEach.where, `${at} forEach`);

  return true;
};

const updateTargetClass = (
  checking: Checking,
  action: Extract<RuleAction, { readonly type: "updateEach" }>,
  at: string
): DefinitionId | undefined => {
  if (action.target === "self") {
    return action.forEach.classId;
  }

  const via = fieldOf(
    checking.snapshot,
    action.forEach.classId,
    action.target.via
  );

  if (via?.type.kind !== "reference") {
    invalid(
      checking,
      `${at} target via ${action.target.via} is not a reference field of its forEach class.`
    );

    return undefined;
  }

  return usableClass(checking, via.type.targetClassId, `${at} target class`)
    ? via.type.targetClassId
    : undefined;
};

const checkCreateParts = (
  checking: Checking,
  action: Extract<RuleAction, { readonly type: "createParts" }>,
  at: string
): void => {
  const source =
    action.forEach === null || checkForEach(checking, action.forEach, at)
      ? (action.forEach?.classId ?? null)
      : undefined;

  if (
    source !== undefined &&
    usableClass(checking, action.classId, `${at} class`)
  ) {
    checkValues(
      checking,
      {
        at,
        nestedSave: false,
        sourceClassId: source,
        targetClassId: action.classId,
      },
      action.values
    );
  }
};

const nestedTargetClass = (
  checking: Checking,
  action: Extract<RuleAction, { readonly type: "updateEach" | "createEach" }>,
  at: string
): DefinitionId | undefined => {
  if (!checkForEach(checking, action.forEach, at)) {
    return undefined;
  }

  if (action.type === "updateEach") {
    return updateTargetClass(checking, action, at);
  }

  return usableClass(checking, action.classId, `${at} class`)
    ? action.classId
    : undefined;
};

const checkNestedSave = (
  checking: Checking,
  action: Extract<RuleAction, { readonly type: "updateEach" | "createEach" }>,
  at: string
): void => {
  const target = nestedTargetClass(checking, action, at);

  if (target !== undefined) {
    checkValues(
      checking,
      {
        at,
        nestedSave: true,
        sourceClassId: action.forEach.classId,
        targetClassId: target,
      },
      action.values
    );
  }
};

const checkAction = (
  checking: Checking,
  action: RuleAction,
  index: number
): void => {
  const at = `action ${index} (${action.type})`;
  const { classId } = checking.rule;

  switch (action.type) {
    case "set": {
      checkValues(
        checking,
        { at, nestedSave: false, sourceClassId: null, targetClassId: classId },
        action.values
      );
      break;
    }

    case "refuse": {
      const { length } = action.message.trim();

      if (length === 0 || action.message.length > REFUSAL_MESSAGE_MAX) {
        invalid(
          checking,
          `${at} needs a fixed message of 1 to ${REFUSAL_MESSAGE_MAX} characters.`
        );
      }

      break;
    }

    case "setParts": {
      if (usableClass(checking, action.classId, `${at} class`)) {
        checkSelection(checking, action.classId, action.where, `${at} where`);
        checkValues(
          checking,
          {
            at,
            nestedSave: false,
            sourceClassId: null,
            targetClassId: action.classId,
          },
          action.values
        );
      }

      break;
    }

    case "createParts": {
      checkCreateParts(checking, action, at);
      break;
    }

    case "updateEach":
    case "createEach": {
      checkNestedSave(checking, action, at);
      break;
    }

    default: {
      action satisfies never;
    }
  }
};

const checkOperations = (checking: Checking): void => {
  const { operations, phase, ruleKind } = checking.rule;
  const unique = new Set(operations).size === operations.length;

  if (phase === "aggregate") {
    if (operations.length > 0) {
      invalid(
        checking,
        "An aggregate rule names no operations: it runs whenever its owner is settled."
      );
    }

    return;
  }

  if (operations.length === 0 || !unique) {
    invalid(
      checking,
      "A record rule names each of its operations once, and at least one."
    );
  }

  if (ruleKind === "derive" && operations.includes("delete")) {
    invalid(
      checking,
      "A derive rule cannot run on delete: a delete stores no values."
    );
  }
};

const checkKindAndActions = (checking: Checking): void => {
  const { actions, phase, ruleKind } = checking.rule;

  if (phase === "before" && ruleKind === null) {
    invalid(
      checking,
      "A before rule needs a kind: derive, guard or invariant."
    );
  }

  if (phase !== "before" && ruleKind !== null) {
    invalid(checking, `Only before rules have a kind; this is ${phase}.`);
  }

  if (actions.length === 0) {
    invalid(checking, "A record rule has at least one action.");
  }

  const allowed: ReadonlySet<RuleAction["type"]> = new Set(
    phase === "before" && ruleKind !== null
      ? [KIND_ACTIONS[ruleKind]]
      : PHASE_ACTIONS[phase]
  );

  for (const [index, action] of actions.entries()) {
    if (allowed.has(action.type)) {
      checkAction(checking, action, index);
    } else {
      const what = phase === "before" && ruleKind !== null ? ruleKind : phase;

      invalid(
        checking,
        `action ${index} (${action.type}) is not allowed in a ${what} rule; it allows ${[...allowed].join(", ")}.`
      );
    }
  }
};

const carrierProblem = (
  rule: RecordRuleDefinition,
  subscription: SubscriptionDefinition
): string | undefined => {
  if (subscription.classId !== rule.classId) {
    return "is on another class";
  }

  if (subscription.condition !== null) {
    return "has a condition of its own";
  }

  const listed = new Set<string>(subscription.operations);

  const same =
    subscription.operations.length === rule.operations.length &&
    rule.operations.every((operation) => listed.has(operation));

  return same ? undefined : "lists other operations";
};

const checkPhaseProperties = (checking: Checking): void => {
  const { rule, snapshot } = checking;

  if (rule.once && rule.phase !== "aggregate") {
    invalid(checking, "Only aggregate rules can be once.");
  }

  if (rule.runAsId !== null && rule.phase !== "after") {
    invalid(checking, "Only after rules name a run-as identity.");
  }

  if (rule.phase !== "afterCommit") {
    if (rule.subscriptionId !== null) {
      invalid(checking, "Only afterCommit rules name a subscription.");
    }

    return;
  }

  if (rule.subscriptionId === null) {
    invalid(
      checking,
      "An afterCommit rule names the subscription whose deliveries run it."
    );

    return;
  }

  const subscription = snapshot.get(rule.subscriptionId);

  if (subscription?.kind !== "subscription" || !isLive(subscription)) {
    invalid(
      checking,
      `Its subscription ${rule.subscriptionId} is not a live subscription.`
    );

    return;
  }

  const found = carrierProblem(rule, subscription);

  if (found !== undefined) {
    invalid(
      checking,
      `Its subscription ${subscription.id} ${found}: an afterCommit rule's subscription is on the rule's class, lists the rule's operations and has no condition.`
    );
  }
};

/**
 * The user a rule's actions run as when it is not the acting user: an
 * `after` rule's `runAsId`, an `afterCommit` rule's subscription identity
 * (4.1, 4.10). Null for every other rule.
 *
 * @param snapshot - The configuration.
 * @param rule - A record rule.
 * @returns The identity, or null.
 */
export const runIdentityOf = (
  snapshot: ConfigSnapshot,
  rule: RecordRuleDefinition
): DefinitionId | null => {
  if (rule.phase === "after") {
    return rule.runAsId;
  }

  if (rule.phase !== "afterCommit" || rule.subscriptionId === null) {
    return null;
  }

  const subscription = snapshot.get(rule.subscriptionId);

  return subscription?.kind === "subscription" ? subscription.identityId : null;
};

/**
 * The `rules.run_as` check of a change set (Contracts 4.1, decision 0022):
 * a local change that leaves a record rule active with a run identity
 * other than the requester (an `after` rule's `runAs`, an `afterCommit`
 * rule's subscription identity, also when the subscription changes) needs
 * the permission. Set loads are exempt: installing a set is the
 * operator's act, and its rules are trusted like its access rules.
 *
 * @param input - The configuration before and after, the changed IDs,
 *   whether the change is a local edit, and the requester.
 * @returns The refusal, or undefined when allowed.
 */
export const runAsRefusal = (input: {
  readonly before: ConfigSnapshot;
  readonly after: ConfigSnapshot;
  readonly changed: ReadonlySet<DefinitionId>;
  readonly local: boolean;
  readonly requester: Requester;
}): PermissionRequired | undefined => {
  if (!input.local) {
    return undefined;
  }

  const needs = input.after.recordRules().some((rule) => {
    const touched =
      input.changed.has(rule.id) ||
      (rule.subscriptionId !== null && input.changed.has(rule.subscriptionId));

    const identity = runIdentityOf(input.after, rule);
    const running = rule.active && isActive(rule);

    const otherIdentity =
      identity !== null && identity !== input.requester.userId;

    return touched && running && otherIdentity;
  });

  const permissionId = PERMISSION_IDS["rules.run_as"];

  if (!needs || hasPermission(input.before, input.requester, permissionId)) {
    return undefined;
  }

  const permission = input.before.get(permissionId);

  return new PermissionRequired({
    permission:
      permission?.kind === "permission" ? permission.name : "rules.run_as",
    permissionId,
  });
};

/**
 * The problems of one record rule.
 *
 * @param snapshot - The configuration after the change.
 * @param rule - A live record rule.
 * @param purpose - `store` when its condition or actions are new or
 *   changed (retired fields refused), `evaluate` otherwise.
 * @returns Every problem found.
 */
export const recordRuleProblems = (
  snapshot: ConfigSnapshot,
  rule: RecordRuleDefinition,
  purpose: ConditionPurpose
): readonly DefinitionProblem[] => {
  const checking: Checking = { problems: [], purpose, rule, snapshot };
  const nameFound = identifierProblem(rule.name);

  if (nameFound !== undefined) {
    checking.problems.push(
      problem(
        "invalidName",
        rule.id,
        `The record rule name "${rule.name}" is not a valid identifier (${nameFound}).`
      )
    );
  }

  if (!Number.isSafeInteger(rule.order)) {
    invalid(checking, "The order is a whole number.");
  }

  if (!usableClass(checking, rule.classId, "class")) {
    return checking.problems;
  }

  checkOperations(checking);
  checkPhaseProperties(checking);

  if (rule.condition !== null) {
    conditionAt(
      checking,
      "condition",
      conditionProblems(
        snapshot,
        rule.classId,
        rule.condition,
        "recordRule",
        purpose
      )
    );
  }

  checkKindAndActions(checking);

  return checking.problems;
};
