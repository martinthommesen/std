/**
 * The saved list filters one caller may use through an endpoint (decision
 * 0019), for the metadata endpoint (Contracts 6.3).
 *
 * A saved filter of the endpoint E or one of its ancestors is served when
 * the list API would accept its condition from this caller: checked under
 * the `filter` profile (Contracts 5.10) against the caller's view, where
 * every hop sees only the fields the caller can read on a table the caller
 * knows, and retired fields are refused as in a new filter. A filter that
 * names a field the caller cannot read is therefore left out whole, exactly
 * as if it named a field that does not exist, so the metadata reveals no
 * hidden field through a filter. Served filters carry the AST (fields by
 * stable ID) and the same condition printed in the text syntax with the
 * current names, which is why a rename never breaks one.
 */
import { decodeExpr } from "@std/conditions/ast";
import { checkConditionJson } from "@std/conditions/check";
import type { ClassView, FieldInfo } from "@std/conditions/class-view";
import { printCondition } from "@std/conditions/syntax-print";
import { withChoices } from "@std/definitions/condition-view";
import type { DefinitionId } from "@std/definitions/ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { MetaSavedFilter } from "@std/definitions/table-metadata";
import type { JsonValue } from "@std/values/json-value";

import { knowsTable } from "./rules.ts";
import type { Caller } from "./rules.ts";
import { visibleSchema } from "./visible-schema.ts";
import type { VisibleSchema } from "./visible-schema.ts";

/**
 * The condition engine's view of what a caller may name in a filter: on
 * every class, the fields of its visible schema, and nothing on a table
 * the caller does not know. It matches the list API's view of the `filter`
 * parameter.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @returns The class view.
 */
export const callerFilterView = (
  snapshot: ConfigSnapshot,
  caller: Caller
): ClassView => {
  const views = new Map<DefinitionId, VisibleSchema | undefined>();

  const viewOf = (classId: DefinitionId): VisibleSchema | undefined => {
    if (!views.has(classId)) {
      views.set(
        classId,
        snapshot.class(classId) !== undefined &&
          knowsTable(snapshot, caller, classId)
          ? visibleSchema(snapshot, caller, classId)
          : undefined
      );
    }

    return views.get(classId);
  };

  const infoOf = (
    found: ReturnType<VisibleSchema["byId"]>
  ): FieldInfo | undefined =>
    found === undefined
      ? undefined
      : withChoices(snapshot, {
          classId: found.field.classId,
          id: found.field.id,
          name: found.field.name,
          retired: found.field.state === "retired",
          type: found.field.type,
        });

  const field = (classId: DefinitionId, fieldId: DefinitionId) =>
    infoOf(viewOf(classId)?.byId(fieldId));

  return {
    canRead: (classId, fieldId) => field(classId, fieldId) !== undefined,
    field,
    fieldByName: (classId, name) => infoOf(viewOf(classId)?.byName(name)),
  };
};

/**
 * The text of a saved filter's condition for a caller, or undefined when
 * the caller may not use it.
 *
 * @param view - The caller's filter view.
 * @param classId - The endpoint's class.
 * @param condition - The stored condition.
 * @returns The filter text.
 */
const usableText = (
  view: ClassView,
  classId: DefinitionId,
  condition: JsonValue
): string | undefined => {
  const checked = checkConditionJson(condition, {
    classId,
    profile: "filter",
    purpose: "store",
    view,
  });

  const expr = decodeExpr(condition);

  if (!checked.ok || expr._tag === "Failure") {
    return undefined;
  }

  const printed = printCondition(expr.success, {
    classId,
    field: view.field,
  });

  return printed.ok ? printed.value : undefined;
};

/**
 * The saved filters of an endpoint the caller may use.
 *
 * @param snapshot - The configuration at the request's revision.
 * @param caller - The caller's roles.
 * @param classId - The endpoint's class E.
 * @returns Filters of E and its ancestors, root first, then by name.
 */
export const savedFiltersFor = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId
): MetaSavedFilter[] => {
  const view = callerFilterView(snapshot, caller);

  return snapshot.lineage(classId).flatMap((level) => {
    const table = snapshot.qualifiedNameOf(level.id) ?? level.name;

    return snapshot
      .savedFiltersOf(level.id)
      .filter((filter) => filter.state === "active")
      .toSorted((left, right) => (left.name < right.name ? -1 : 1))
      .flatMap((filter): MetaSavedFilter[] => {
        const condition: JsonValue = filter.condition;
        const text = usableText(view, classId, condition);

        return text === undefined
          ? []
          : [
              {
                condition,
                filter: text,
                id: filter.id,
                label: filter.label,
                name: filter.name,
                table,
              },
            ];
      });
  });
};

// A field as `/api/v2` names it.
const apiNamed = (info: FieldInfo | undefined): FieldInfo | undefined =>
  info === undefined
    ? undefined
    : { ...info, name: apiAttributeNameOf(info.name) };

/**
 * The text of a saved filter's condition for a caller in `/api/v2` names
 * (Contracts 10.3), as v2's `condition` parameter takes it, or undefined
 * when the caller may not use it.
 *
 * @param snapshot - The configuration at the request's revision.
 * @param caller - The caller's roles.
 * @param classId - The endpoint's class E.
 * @param condition - The stored condition.
 * @returns The filter text with API names.
 */
export const apiFilterText = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId,
  condition: JsonValue
): string | undefined => {
  const view = callerFilterView(snapshot, caller);

  return usableText(
    {
      ...view,
      field: (owner, fieldId) => apiNamed(view.field(owner, fieldId)),
    },
    classId,
    condition
  );
};
