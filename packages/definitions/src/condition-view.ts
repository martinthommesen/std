/**
 * Checking stored conditions with `@std/conditions` (Contracts 5.2, 5.10):
 * the class view over a config snapshot, and the check of an access-rule or
 * subscription condition when it is stored.
 */
import { checkConditionJson } from "@std/conditions/check";
import type { ClassView, FieldInfo } from "@std/conditions/class-view";
import type { ConditionProfile } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";

import { conditionPaths } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type { FieldDefinition } from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

const fieldInfo = (field: FieldDefinition): FieldInfo => ({
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
    const found = snapshot
      .fields(classId)
      .find((field) => field.id === fieldId);

    return found === undefined ? undefined : fieldInfo(found);
  },
  fieldByName: (classId, name) => {
    const found = snapshot.fieldByName(classId, name);

    return found === undefined ? undefined : fieldInfo(found);
  },
});

/** Whether a condition is being stored now or was stored earlier. */
export type ConditionPurpose = "store" | "evaluate";

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
 * @returns Messages, empty when the condition is acceptable.
 */
export const conditionProblems = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId | null,
  condition: Condition,
  profile: ConditionProfile,
  purpose: ConditionPurpose = "store"
): readonly string[] => {
  if (classId === null) {
    return conditionPaths(condition).length === 0
      ? []
      : ["A rule on every table (*) cannot read fields in its condition."];
  }

  const json: JsonValue = condition;

  const checked = checkConditionJson(json, {
    classId,
    profile,
    purpose,
    view: classViewOf(snapshot),
  });

  return checked.ok
    ? []
    : checked.error.issues.map(
        (issue) =>
          `${issue.reason} at ${issue.path.join(".") || "root"}: ${issue.message}`
      );
};
