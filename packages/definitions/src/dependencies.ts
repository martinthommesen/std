/**
 * The dependency index (Contracts 1.7): every reference between config
 * records, as `(from_id, to_id, kind)` rows in `core.config_dependency`.
 *
 * Kinds registered so far: `extends`, `field_of`, `references_table`,
 * `index_on`, `display_field`, `access_rule_on`, `rule_role`, `overrides`,
 * `condition_reads`, `subscription_on` (a subscription to its class) and
 * `grant_of` (a grant to its role and its permission). Later features add
 * `layout_uses`, `rule_writes` and `choice_of`.
 */
import { conditionFieldIds } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type { AccessTarget, Definition } from "./definition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";

/** Dependency kinds that exist in this version. */
export type DependencyKind =
  | "extends"
  | "field_of"
  | "references_table"
  | "index_on"
  | "display_field"
  | "access_rule_on"
  | "rule_role"
  | "overrides"
  | "condition_reads"
  | "subscription_on"
  | "grant_of";

/** One dependency: `from` refers to `to`. */
export interface Dependency {
  readonly fromId: DefinitionId;
  readonly toId: DefinitionId;
  readonly kind: DependencyKind;
}

const edge = (
  fromId: DefinitionId,
  toId: DefinitionId,
  kind: DependencyKind
): Dependency => ({ fromId, kind, toId });

const conditionEdges = (
  id: DefinitionId,
  condition: Condition | null
): readonly Dependency[] =>
  condition === null
    ? []
    : conditionFieldIds(condition).map((fieldId) =>
        edge(id, fieldId, "condition_reads")
      );

// Fields an access rule targets explicitly are references too (`*` names none).
const targetEdges = (
  id: DefinitionId,
  target: AccessTarget
): readonly Dependency[] =>
  target.kind === "fields" && target.fields !== "*"
    ? target.fields.map((fieldId) => edge(id, fieldId, "access_rule_on"))
    : [];

const edgesOf = (definition: Definition): readonly Dependency[] => {
  const { id } = definition;

  if (definition.kind === "class") {
    return [
      ...(definition.parentId === null
        ? []
        : [edge(id, definition.parentId, "extends")]),
      ...(definition.displayFieldId === null
        ? []
        : [edge(id, definition.displayFieldId, "display_field")]),
    ];
  }

  if (definition.kind === "field") {
    return definition.type.kind === "reference"
      ? [
          edge(id, definition.classId, "field_of"),
          edge(id, definition.type.targetClassId, "references_table"),
        ]
      : [edge(id, definition.classId, "field_of")];
  }

  if (definition.kind === "override") {
    return [
      edge(id, definition.fieldId, "overrides"),
      edge(id, definition.classId, "overrides"),
    ];
  }

  if (definition.kind === "index") {
    return [
      edge(id, definition.classId, "index_on"),
      ...definition.fieldIds.map((fieldId) => edge(id, fieldId, "index_on")),
    ];
  }

  if (definition.kind === "accessRule") {
    return [
      ...(definition.classId === null
        ? []
        : [edge(id, definition.classId, "access_rule_on")]),
      ...targetEdges(id, definition.target),
      ...definition.roleIds.map((roleId) => edge(id, roleId, "rule_role")),
      ...conditionEdges(id, definition.condition),
    ];
  }

  if (definition.kind === "grant") {
    return [
      edge(id, definition.roleId, "grant_of"),
      edge(id, definition.permissionId, "grant_of"),
    ];
  }

  return definition.kind === "subscription"
    ? [
        edge(id, definition.classId, "subscription_on"),
        ...conditionEdges(id, definition.condition),
      ]
    : [];
};

/**
 * The dependencies of one definition. Purged definitions have none.
 *
 * - class: `extends` its parent, `display_field` its display field;
 * - field: `field_of` its class, `references_table` a reference's target;
 * - override: `overrides` its field and its class;
 * - index: `index_on` its class and each of its fields;
 * - access rule: `access_rule_on` its class and each field it targets by
 *   ID, `rule_role` each role,
 *   `condition_reads` each field its condition reads;
 * - grant: `grant_of` its role and its permission;
 * - subscription: `subscription_on` its class, `condition_reads` each field
 *   its condition reads.
 *
 * @param definition - Any definition.
 * @returns Its dependencies, sorted by kind and target.
 */
export const dependenciesOf = (
  definition: Definition
): readonly Dependency[] => {
  if (definition.state === "purged") {
    return [];
  }

  const edges = edgesOf(definition);

  const unique = new Map(
    edges.map((entry) => [`${entry.kind}/${entry.toId}`, entry])
  );

  return [...unique.values()].toSorted(
    (left, right) =>
      compareIds(left.kind, right.kind) || compareIds(left.toId, right.toId)
  );
};
