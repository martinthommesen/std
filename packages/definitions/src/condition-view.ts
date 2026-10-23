/**
 * Checking stored conditions with `@std/conditions` (Contracts 5.2, 5.10):
 * the class view over a config snapshot, and the check of an access-rule or
 * subscription condition when it is stored.
 */
import {
  checkAggregateCondition,
  checkPartCondition,
} from "@std/conditions/aggregate";
import { decodeExpr } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import { checkConditionJson } from "@std/conditions/check";
import type { CheckOptions } from "@std/conditions/check";
import type { ClassView, FieldInfo } from "@std/conditions/class-view";
import type { ConditionResult } from "@std/conditions/issue";
import type { ChoiceList } from "@std/values/choice";
import type { ConditionProfile } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { isSuccess } from "effect/Result";

import { isPartClassOf } from "./aggregates.ts";
import { conditionPaths } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type { FieldDefinition } from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import { choiceListOf } from "./record-rules.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/**
 * A choice field's keys as conditions check literals against them
 * (Contracts 5.2): every live choice of the field, the class's subset not
 * applied, so a filter through a parent endpoint can name a key only a
 * child allows; a hidden choice is retired, which a literal may still name.
 *
 * @param snapshot - The configuration.
 * @param field - A field.
 * @returns The keys, or undefined for a field that is not a choice field.
 */
export const conditionChoicesOf = (
  snapshot: ConfigSnapshot,
  field: Pick<FieldDefinition, "id" | "type">
): ChoiceList | undefined => {
  if (field.type.kind !== "choice") {
    return undefined;
  }

  return choiceListOf(snapshot.choicesOf(field.id));
};

/**
 * A field info with its choices, when it is a choice field.
 *
 * @param snapshot - The configuration.
 * @param info - The field info.
 * @returns The info, with `choices` for a choice field.
 */
export const withChoices = (
  snapshot: ConfigSnapshot,
  info: FieldInfo
): FieldInfo => {
  const choices = conditionChoicesOf(snapshot, info);

  return choices === undefined ? info : { ...info, choices };
};

const fieldInfo = (
  snapshot: ConfigSnapshot,
  field: FieldDefinition
): FieldInfo =>
  withChoices(snapshot, {
    classId: field.classId,
    id: field.id,
    name: field.name,
    retired: field.state === "retired",
    type: field.type,
  });

/**
 * The condition engine's view of a snapshot: a class's own and inherited
 * live fields, retired ones marked; purged fields are not visible.
 *
 * @param snapshot - The configuration.
 * @returns The view.
 */
export const classViewOf = (snapshot: ConfigSnapshot): ClassView => ({
  field: (classId, fieldId) => {
    const found = snapshot.field(fieldId);

    return found === undefined ||
      found.state === "purged" ||
      !snapshot.lineage(classId).some((level) => level.id === found.classId)
      ? undefined
      : fieldInfo(snapshot, found);
  },
  fieldByName: (classId, name) => {
    const found = snapshot.fieldByName(classId, name);

    return found === undefined ? undefined : fieldInfo(snapshot, found);
  },
});

/** Whether a condition is being stored now or was stored earlier. */
export type ConditionPurpose = "store" | "evaluate";

const messagesOf = (checked: ConditionResult<unknown>): readonly string[] =>
  checked.ok
    ? []
    : checked.error.issues.map(
        (issue) =>
          `${issue.reason} at ${issue.path.join(".") || "root"}: ${issue.message}`
      );

/**
 * Checks a condition as it is stored on an access rule (`accessRule`
 * profile, no reference hops in Step 1) or a subscription (`subscription`
 * profile). A rule on `*` (no class) may only use conditions that read no
 * field.
 *
 * @param snapshot - The configuration after the change.
 * @param classId - The class the condition is evaluated on, or null for `*`.
 * @param condition - The condition.
 * @param profile - The profile it is checked under.
 * @param purpose - `store` for a condition being stored or edited, which
 *   may not use retired fields; `evaluate` for one stored earlier, which
 *   keeps working after a field it reads is retired (Contracts 1.6, 1.7).
 * @param recordClassId - For a record rule's `forEach.where`: the class of
 *   the rule's own record, which `scope: "record"` paths read (4.10).
 * @returns Messages, empty when the condition is acceptable.
 */
export const conditionProblems = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId | null,
  condition: Condition,
  profile: ConditionProfile,
  purpose: ConditionPurpose = "store",
  recordClassId?: DefinitionId
): readonly string[] => {
  if (classId === null) {
    return conditionPaths(condition).length === 0
      ? []
      : ["A rule on every table (*) cannot read fields in its condition."];
  }

  const json: JsonValue = condition;

  const options: CheckOptions = {
    classId,
    profile,
    purpose,
    view: classViewOf(snapshot),
  };

  const checked = checkConditionJson(
    json,
    recordClassId === undefined ? options : { ...options, recordClassId }
  );

  return messagesOf(checked);
};

const decoded = (condition: Condition): Expr | undefined => {
  const json: JsonValue = condition;
  const result = decodeExpr(json);

  return isSuccess(result) ? result.success : undefined;
};

const NOT_AN_AST = ["malformed at root: The value is not a condition AST."];

/**
 * Checks the condition of an aggregate record rule (Contracts 5.10): the
 * record-rule profile on the owner (the rule's class), with
 * `partsChanged`, `anyPart` and `allParts` over its part classes.
 *
 * @param snapshot - The configuration after the change.
 * @param classId - The rule's class.
 * @param condition - The condition.
 * @param purpose - `store` or `evaluate`.
 * @returns Messages, empty when the condition is acceptable.
 */
export const aggregateConditionProblems = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  condition: Condition,
  purpose: ConditionPurpose
): readonly string[] => {
  const expr = decoded(condition);

  return expr === undefined
    ? NOT_AN_AST
    : messagesOf(
        checkAggregateCondition(expr, {
          classId,
          isPartClass: (partClassId) =>
            isPartClassOf(snapshot, partClassId, classId),
          purpose,
          view: classViewOf(snapshot),
        })
      );
};

/**
 * Checks a condition on an owner's parts of a class (a `setParts.where`,
 * Contracts 4.10): paths read the part, `scope: "owner"` paths the owner.
 *
 * @param snapshot - The configuration after the change.
 * @param partClassId - The part class.
 * @param ownerClassId - The rule's class.
 * @param condition - The condition.
 * @param purpose - `store` or `evaluate`.
 * @returns Messages, empty when the condition is acceptable.
 */
export const partConditionProblems = (
  snapshot: ConfigSnapshot,
  partClassId: DefinitionId,
  ownerClassId: DefinitionId,
  condition: Condition,
  purpose: ConditionPurpose
): readonly string[] => {
  const expr = decoded(condition);

  return expr === undefined
    ? NOT_AN_AST
    : messagesOf(
        checkPartCondition(expr, partClassId, ownerClassId, {
          purpose,
          view: classViewOf(snapshot),
        })
      );
};
