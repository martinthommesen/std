/** Caller-safe form rules: substitute empty before delivering conditions (Contracts 5.10). */
import { simplifyForCaller } from "@std/conditions/simplify";
import { ConditionSchema } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import { formRulesOf } from "@std/definitions/form-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { MetaFormRule } from "@std/definitions/table-metadata";
import { Schema } from "effect";

import { fieldDecision } from "./rules.ts";
import type { Caller } from "./rules.ts";
import { visibleSchema } from "./visible-schema.ts";

/**
 * The rules the caller can see, with no never-readable field in their conditions.
 * @param snapshot - The effective configuration.
 * @param caller - The caller and effective roles.
 * @param classId - The concrete class.
 * @returns Visible rules whose conditions name no never-readable field.
 */
export const formRulesFor = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: string
): readonly MetaFormRule[] => {
  const visible = new Set(
    visibleSchema(snapshot, caller, classId).fields.map(
      (entry) => entry.field.id
    )
  );

  const ownLineageFieldIds = new Set(
    snapshot.fields(classId).map((field) => field.id)
  );

  const isHidden = (fieldId: string): boolean => {
    const field = snapshot.field(fieldId);

    if (field === undefined) {
      return true;
    }

    const onClass = ownLineageFieldIds.has(fieldId) ? classId : field.classId;

    return (
      fieldDecision(snapshot, caller, "read", onClass, fieldId).kind === "never"
    );
  };

  return formRulesOf(snapshot, classId).flatMap((rule) =>
    visible.has(rule.fieldId)
      ? [
          {
            clearHidden: rule.clearHidden ?? null,
            // Stored form conditions check on write; simplification preserves that grammar.
            condition: Schema.decodeUnknownSync(ConditionSchema)(
              simplifyForCaller(rule.condition ?? { op: "true" }, {
                classId,
                isHidden,
                view: classViewOf(snapshot),
              })
            ),
            fieldId: rule.fieldId,
            id: rule.id,
            message: rule.message ?? null,
            order: rule.order,
            property: rule.property,
            value: rule.value,
          },
        ]
      : []
  );
};
