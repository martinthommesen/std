/**
 * The dependency index (Contracts 1.7): every reference between config
 * records, as `(from_id, to_id, kind)` rows in `core.config_dependency`.
 *
 * Kinds registered so far: `extends`, `field_of`, `references_table`,
 * `condition_on` (a condition field to the class its conditions apply to),
 * `index_on`, `display_field`, `access_rule_on`, `rule_role`, `overrides`,
 * `condition_reads`, `subscription_on` (a subscription to its class),
 * `grant_of` (a grant to its role and its permission), `choice_of` (a
 * choice to its field) and `layout_uses` (a layout to its class and to each
 * field it shows), and `saved_filter_on` (a saved filter to its class;
 * the fields its condition reads are `condition_reads`, decision 0019).
 * Step 3 adds `rule_on` (a record rule to its class, every class its
 * actions name and an `afterCommit` rule's subscription) and `rule_writes`
 * (a record rule to every field its actions set; the fields it reads are
 * `condition_reads`), decision 0022.
 */
import type { FieldType } from "@std/values/field-type";

import { allowedRecordsOf } from "./allowed-records.ts";
import { conditionFieldIds } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type {
  AccessRuleDraft,
  AccessTarget,
  ChoiceDraft,
  ClassDraft,
  Definition,
  DefinitionKind,
  FieldDraft,
  GrantDraft,
  IndexDraft,
  LayoutDraft,
  SavedFilterDraft,
  NamespaceDraft,
  OverrideDraft,
  PermissionDraft,
  RecordRuleDraft,
  FormRuleDraft,
  RoleDraft,
  SubscriptionDraft,
} from "./definition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import { ruleReferences } from "./rule-references.ts";

/** Dependency kinds that exist in this version. */
export const DEPENDENCY_KINDS = [
  "extends",
  "field_of",
  "references_table",
  "condition_on",
  "index_on",
  "display_field",
  "access_rule_on",
  "rule_role",
  "overrides",
  "condition_reads",
  "subscription_on",
  "grant_of",
  "choice_of",
  "layout_uses",
  "saved_filter_on",
  "rule_on",
  "rule_writes",
] as const;

/** A dependency kind. */
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/**
 * What references are read from: a stored definition, or a create's draft
 * (the same properties, before the engine adds state, version and
 * enforcement).
 */
export type Referencing =
  | Definition
  | NamespaceDraft
  | ClassDraft
  | FieldDraft
  | OverrideDraft
  | IndexDraft
  | RoleDraft
  | PermissionDraft
  | GrantDraft
  | AccessRuleDraft
  | SubscriptionDraft
  | ChoiceDraft
  | LayoutDraft
  | SavedFilterDraft
  | RecordRuleDraft
  | FormRuleDraft;

/** One dependency: `from` refers to `to`. */
export interface Dependency {
  readonly fromId: DefinitionId;
  readonly toId: DefinitionId;
  readonly kind: DependencyKind;
}

/**
 * The definition kinds that refer to other definitions (`edgesOf`); the
 * rest (namespaces, roles, permissions) never have dependencies.
 */
export const REFERENCING_KINDS: ReadonlySet<DefinitionKind> =
  new Set<DefinitionKind>([
    "class",
    "field",
    "override",
    "index",
    "accessRule",
    "grant",
    "subscription",
    "choice",
    "layout",
    "savedFilter",
    "recordRule",
    "formRule",
  ]);

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

/**
 * The class a field's type names: a reference's target, or the class a
 * condition field's conditions apply to.
 *
 * @param type - The field type.
 * @returns The class ID, or null for other types.
 */
export const typeClassOf = (type: FieldType): DefinitionId | null => {
  if (type.kind === "reference") {
    return type.targetClassId;
  }

  return type.kind === "condition" ? type.classId : null;
};

const typeEdges = (
  id: DefinitionId,
  type: FieldType
): readonly Dependency[] => {
  if (type.kind === "reference") {
    return [
      edge(id, type.targetClassId, "references_table"),
      ...conditionEdges(id, allowedRecordsOf(type) ?? null),
    ];
  }

  return type.kind === "condition"
    ? [edge(id, type.classId, "condition_on")]
    : [];
};

// Fields an access rule targets explicitly are references too (`*` names none).
const targetEdges = (
  id: DefinitionId,
  target: AccessTarget
): readonly Dependency[] =>
  target.kind === "fields" && target.fields !== "*"
    ? target.fields.map((fieldId) => edge(id, fieldId, "access_rule_on"))
    : [];

const edgesOf = (definition: Referencing): readonly Dependency[] => {
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
    return [
      edge(id, definition.classId, "field_of"),
      ...typeEdges(id, definition.type),
    ];
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

  if (definition.kind === "choice") {
    return [edge(id, definition.fieldId, "choice_of")];
  }

  if (definition.kind === "layout") {
    return [
      edge(id, definition.classId, "layout_uses"),
      ...definition.elements.flatMap((element) =>
        element.kind === "field"
          ? [edge(id, element.fieldId, "layout_uses")]
          : []
      ),
    ];
  }

  if (definition.kind === "savedFilter") {
    return [
      edge(id, definition.classId, "saved_filter_on"),
      ...conditionEdges(id, definition.condition),
    ];
  }

  if (definition.kind === "formRule") {
    return [
      edge(id, definition.classId, "rule_on"),
      edge(id, definition.fieldId, "rule_writes"),
      ...conditionEdges(id, definition.condition),
    ];
  }

  if (definition.kind === "recordRule") {
    const references = ruleReferences(definition);

    return [
      ...references.classes.map((classId) => edge(id, classId, "rule_on")),
      ...references.writes.map((fieldId) => edge(id, fieldId, "rule_writes")),
      ...references.reads.map((fieldId) =>
        edge(id, fieldId, "condition_reads")
      ),
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
 * - field: `field_of` its class, `references_table` a reference's target,
 *   `condition_reads` each field a reference's allowed-records condition
 *   reads,
 *   `condition_on` a condition field's class;
 * - override: `overrides` its field and its class;
 * - index: `index_on` its class and each of its fields;
 * - access rule: `access_rule_on` its class and each field it targets by
 *   ID, `rule_role` each role,
 *   `condition_reads` each field its condition reads;
 * - grant: `grant_of` its role and its permission;
 * - subscription: `subscription_on` its class, `condition_reads` each field
 *   its condition reads;
 * - choice: `choice_of` its field;
 * - layout: `layout_uses` its class and each field element;
 * - saved filter: `saved_filter_on` its class, `condition_reads` each
 *   field its condition reads (every hop);
 * - record rule: `rule_on` its class, the classes its actions name and
 *   its subscription, `rule_writes` each field it sets,
 *   `condition_reads` each field it reads (`rule-references.ts`).
 *
 * @param definition - Any definition.
 * @returns Its dependencies, sorted by kind and target.
 */
export const dependenciesOf = (
  definition: Definition
): readonly Dependency[] => {
  if (
    definition.state === "purged" ||
    !REFERENCING_KINDS.has(definition.kind)
  ) {
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

/**
 * Every definition a definition or draft refers to: the targets of the
 * edges the dependency index records for it, and a class's namespace
 * (which the index leaves out: a namespace is never deleted while it holds
 * classes). Callers that must see what a change set refers to (the HTTP
 * visibility check, Contracts 3.8) use this, so they and the index cannot
 * drift apart.
 *
 * @param definition - A definition or a create's draft.
 * @returns The referenced IDs, without duplicates.
 */
export const referencedIds = (
  definition: Referencing
): readonly DefinitionId[] => [
  ...new Set([
    ...(definition.kind === "class" ? [definition.namespaceId] : []),
    ...edgesOf(definition).map((entry) => entry.toId),
  ]),
];
