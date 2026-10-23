/**
 * Lifecycle operations applied in memory (Contracts 1.1, 1.6, 1.7, 1.8):
 * rename, retire, reactivate, purge and delete, with the protected-
 * definition guard, the dependency checks of the 1.7 table and the
 * definitions they take along (cascades).
 *
 * | Operation | Refused when (blocking dependents) | Reported but allowed | Cascade |
 * | --- | --- | --- | --- |
 * | rename | protected; core or app owned and not its set; the new name is in use before this change set | nothing | none |
 * | retire field | protected; display field of a class; part of a multi-field unique index; an active record rule writes it | other dependents | none (`required` becomes false) |
 * | retire table | protected; an active child class; an active reference field on an active table points at it | other dependents | none |
 * | retire role | protected; an active access rule names it | other dependents | none |
 * | purge field | not retired before this change set; any dependent that is not retired, except single-field indexes, overrides, choices and layout entries (a saved filter reading it blocks, decision 0019) | none | its single-field indexes, overrides and choices (layouts keep the entry, skipped where served) |
 * | purge table | not retired before; a child class or incoming reference field not purged; an access rule, subscription or record rule on it | none | its fields with their choices, indexes, overrides, layouts and saved filters |
 * | delete role | protected; any access rule names it | its grants | its grants |
 * | delete permission | protected | its grants | its grants |
 * | delete field, table, namespace | always (`UseRetireOrPurge`) | | |
 *
 * Purge also needs the `schema.purge` permission, checked by ID through the
 * requester's roles, and a confirmation repeating the target's ID and
 * version. Counting the values or rows destroyed, and refusing a child
 * class whose records also live in ancestor tables that stay, happen on the
 * server under `SCHEMA_KEY`, because they read data.
 */
import type { JsonObject } from "@std/values/json-value";

import {
  checkVersion,
  currentOf,
  decodeAs,
  nextVersion,
  record,
  recordCascade,
  refuse,
  viewOf,
} from "./apply-work.ts";
import type { OperationNote, Work } from "./apply-work.ts";
import type {
  ClassDefinition,
  Definition,
  FieldDefinition,
} from "./definition.ts";
import { isActive, isLive } from "./definition.ts";
import { typeClassOf } from "./dependencies.ts";
import { DependencyConflict } from "./dependency-conflict.ts";
import { dependentsOf, describeDependent } from "./dependents.ts";
import type { DependentEdge } from "./dependents.ts";
import { guardChange } from "./guards.ts";
import type { DefinitionId } from "./ids.ts";
import { NEVER_DELETED, PURGEABLE, RENAMABLE, RETIRABLE } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { PermissionRequired } from "./permission-required.ts";
import { problem } from "./problems.ts";
import { PurgeRefused } from "./purge-refused.ts";
import { hasPermission } from "./requester.ts";
import type { ConfigSnapshot } from "./snapshot.ts";
import { UseRetireOrPurge } from "./use-retire-or-purge.ts";
import { SCHEMA_PURGE_PERMISSION_ID } from "./well-known.ts";

type Op<T extends Operation["op"]> = Extract<Operation, { readonly op: T }>;

const withChanges = (
  work: Work,
  current: Definition,
  changes: JsonObject
): Definition | undefined => {
  const json: JsonObject = current;

  return decodeAs(work, current.id, {
    ...json,
    ...changes,
    version: nextVersion(work, current.id),
  });
};

const unsupported = (work: Work, id: DefinitionId, message: string): void => {
  work.problems.push(problem("unsupportedChange", id, message));
};

const conflict = (
  work: Work,
  target: Definition,
  operation: string,
  blocking: readonly DependentEdge[]
): boolean => {
  if (blocking.length === 0) {
    return false;
  }

  refuse(
    work,
    new DependencyConflict({
      definitionId: target.id,
      dependents: blocking.map(describeDependent),
      operation,
    })
  );

  return true;
};

const note = (
  localOverride: boolean,
  reported: readonly DependentEdge[] = [],
  cascade: readonly DefinitionId[] = []
): OperationNote => ({
  cascade,
  localOverride,
  reported: reported.map(describeDependent),
});

/**
 * Whether another live definition of the same naming scope already has the
 * name in the configuration before the change set. Renames to a name in
 * use, even one this change set frees by renaming its holder, are refused:
 * physical renames run one after another, so a swap would collide.
 *
 * @param snapshot - The configuration before the change set.
 * @param target - The renamed definition.
 * @param name - The new name.
 * @returns The holder's ID, or undefined.
 */
const namingScope = (
  snapshot: ConfigSnapshot,
  target: Definition
): readonly Definition[] => {
  if (target.kind === "field") {
    return snapshot.hierarchyFields(target.classId);
  }

  if (target.kind === "index") {
    return snapshot.indexes(target.classId);
  }

  if (target.kind === "savedFilter") {
    return snapshot.savedFiltersOf(target.classId);
  }

  if (target.kind === "formRule") {
    return snapshot
      .all("formRule")
      .filter((rule) => rule.classId === target.classId && isLive(rule));
  }

  if (target.kind === "recordRule") {
    return snapshot.recordRulesOf(target.classId);
  }

  return target.kind === "class"
    ? snapshot.classesIn(target.namespaceId)
    : snapshot.all(target.kind).filter(isLive);
};

const nameHolderBefore = (
  snapshot: ConfigSnapshot,
  target: Definition,
  name: string
): DefinitionId | undefined => {
  const scope = namingScope(snapshot, target);

  return scope.find(
    (other) => other.id !== target.id && "name" in other && other.name === name
  )?.id;
};

/**
 * `rename`: a new name by ID (Contracts 1.1).
 *
 * @param work - The application.
 * @param operation - The operation.
 */
export const rename = (work: Work, operation: Op<"rename">): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  const allowed = guardChange(work, current, "rename");

  if (allowed === undefined) {
    return;
  }

  if (!(RENAMABLE.has(current.kind) && isLive(current))) {
    unsupported(
      work,
      current.id,
      `A ${current.kind} ${current.state === "purged" ? "tombstone " : ""}cannot be renamed.`
    );

    return;
  }

  const holder = nameHolderBefore(work.snapshot, current, operation.name);

  if (holder !== undefined) {
    work.problems.push(
      problem(
        "duplicateName",
        current.id,
        `The name "${operation.name}" is used by ${holder}; free it in an earlier change set.`
      )
    );

    return;
  }

  const next = withChanges(work, current, { name: operation.name });

  if (next !== undefined) {
    record(work, operation, next, note(allowed.localOverride));
  }
};

/**
 * Whether a field is part of an index on more than one field that is
 * unique (Contracts 1.7: retiring it would leave the uniqueness promise on a
 * field nobody can write).
 *
 * @param edge - A dependent of the field.
 * @returns True for such an index.
 */
const isMultiFieldUnique = (edge: DependentEdge): boolean =>
  edge.definition.kind === "index" &&
  edge.definition.unique &&
  edge.definition.fieldIds.length > 1;

/**
 * Whether an edge is a live table naming the field as its display field,
 * unless the same change set retires that table.
 *
 * @param edge - A dependent edge of a field.
 * @param retiredInChangeSet - What some retire of the change set targets.
 * @returns True for a blocking table.
 */
const isLiveDisplayField = (
  edge: DependentEdge,
  retiredInChangeSet: ReadonlySet<DefinitionId>
): boolean =>
  edge.kind === "display_field" &&
  isLive(edge.definition) &&
  !retiredInChangeSet.has(edge.definition.id);

/**
 * Whether an edge is an active record rule writing the field (Contracts
 * 1.7: "an active rule writes it").
 *
 * @param edge - A dependent edge of a field.
 * @returns True for a blocking rule.
 */
const writtenByActiveRule = (edge: DependentEdge): boolean =>
  edge.kind === "rule_writes" &&
  edge.definition.kind === "recordRule" &&
  edge.definition.active &&
  isActive(edge.definition);

/**
 * What keeps a field from being retired: a live table naming it as its
 * display field, unless the same change set retires that table too, a
 * multi-field unique index on it, and an active record rule writing it
 * (Contracts 1.7).
 *
 * @param edges - The field's dependents.
 * @param retiredInChangeSet - What some retire of the change set targets.
 * @returns The blocking ones.
 */
const retireFieldBlockers = (
  edges: readonly DependentEdge[],
  retiredInChangeSet: ReadonlySet<DefinitionId>
): readonly DependentEdge[] =>
  edges.filter(
    (edge) =>
      isLiveDisplayField(edge, retiredInChangeSet) ||
      isMultiFieldUnique(edge) ||
      writtenByActiveRule(edge)
  );

/**
 * Whether a class and every ancestor are active: only then are its records
 * writable and its fields count as non-retired.
 *
 * @param view - The configuration so far.
 * @param classId - The class.
 * @returns True when the class is active with all its ancestors.
 */
export const isActiveLineage = (
  view: ConfigSnapshot,
  classId: DefinitionId
): boolean => {
  const lineage = view.lineage(classId);

  return lineage.length > 0 && lineage.every(isActive);
};

/**
 * What keeps a table from being retired: an active child class, or an
 * active reference field pointing at it or condition field naming it,
 * whatever its own table's state and including the table's own fields
 * (Contracts 1.7). The field's own state decides; retire it first.
 *
 * @param edges - The table's dependents.
 * @returns The blocking ones.
 */
/**
 * The dependency kinds by which a field's type names a table: a
 * reference's target, a condition field's class.
 */
const NAMES_TABLE: ReadonlySet<DependentEdge["kind"]> = new Set<
  DependentEdge["kind"]
>(["references_table", "condition_on"]);

const retireClassBlockers = (
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  edges.filter(({ definition, kind }) => {
    if (kind === "extends") {
      return isActive(definition);
    }

    return (
      NAMES_TABLE.has(kind) &&
      definition.kind === "field" &&
      isActive(definition)
    );
  });

const roleRuleBlockers = (
  edges: readonly DependentEdge[],
  activeOnly: boolean
): readonly DependentEdge[] =>
  edges.filter(({ definition, kind }) => {
    if (kind !== "rule_role" || definition.kind !== "accessRule") {
      return false;
    }

    return !activeOnly || (isActive(definition) && definition.active);
  });

const blockersForRetire = (
  current: Definition,
  edges: readonly DependentEdge[],
  retiredInChangeSet: ReadonlySet<DefinitionId>
): readonly DependentEdge[] => {
  if (current.kind === "field") {
    return retireFieldBlockers(edges, retiredInChangeSet);
  }

  if (current.kind === "class") {
    return retireClassBlockers(edges);
  }

  return roleRuleBlockers(edges, true);
};

/**
 * The overrides that make a field required on descendant classes. Retiring
 * the field clears their `required`, so the field is optional on every
 * class while retired and comes back optional everywhere when reactivated
 * (Contracts 1.6). Their other tightenings stay.
 *
 * @param edges - The field's dependents.
 * @returns The overrides.
 */
const requiringOverrides = (
  edges: readonly DependentEdge[]
): readonly Definition[] =>
  edges.flatMap(({ definition, kind }) =>
    kind === "overrides" &&
    definition.kind === "override" &&
    definition.required === true
      ? [definition]
      : []
  );

const retiredState = (current: Definition): JsonObject =>
  current.kind === "field"
    ? { required: false, state: "retired" }
    : { state: "retired" };

/**
 * `retire`: a field, table or role keeps its data and refuses writes; a
 * retired field becomes optional (Contracts 1.6).
 *
 * @param work - The application.
 * @param operation - The operation.
 */
export const retire = (work: Work, operation: Op<"retire">): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  const allowed = guardChange(work, current, "retire");

  if (allowed === undefined) {
    return;
  }

  if (!RETIRABLE.has(current.kind) || !isActive(current)) {
    unsupported(
      work,
      current.id,
      `This ${current.kind} is ${current.state} and cannot be retired.`
    );

    return;
  }

  const view = viewOf(work);
  const edges = dependentsOf(view, current.id);
  const blocking = blockersForRetire(current, edges, work.retiredInChangeSet);
  const blockingSet = new Set(blocking);

  if (conflict(work, current, "retire", blocking)) {
    return;
  }

  const next = withChanges(work, current, retiredState(current));

  if (next === undefined) {
    return;
  }

  const loosened = requiringOverrides(edges);

  for (const override of loosened) {
    const optional = withChanges(work, override, { required: null });

    if (optional !== undefined) {
      recordCascade(work, optional);
    }
  }

  record(
    work,
    operation,
    next,
    note(
      allowed.localOverride,
      edges.filter((edge) => !blockingSet.has(edge)),
      loosened.map((override) => override.id)
    )
  );
};

/**
 * The tables that are not active and that an active reference or condition
 * field of the reactivated definition would name: a reactivated field must
 * not name a retired table, nor may a reactivated table carry an active
 * field that does (Contracts 1.7, the retire rule seen from the other
 * side).
 *
 * @param view - The configuration so far.
 * @param current - The definition to reactivate.
 * @returns The targets, as dependents of kind `references_table` or
 *   `condition_on`.
 */
const inactiveTargets = (
  view: ConfigSnapshot,
  current: Definition
): readonly DependentEdge[] => {
  let fields: readonly FieldDefinition[] = [];

  if (current.kind === "field") {
    fields = [current];
  } else if (current.kind === "class") {
    fields = view.ownFields(current.id).filter(isActive);
  }

  return fields.flatMap((field) => {
    const targetId = typeClassOf(field.type);
    const target = targetId === null ? undefined : view.class(targetId);

    const kind =
      field.type.kind === "condition" ? "condition_on" : "references_table";

    // A table's reference to itself becomes active with it.
    return target === undefined || isActive(target) || target.id === current.id
      ? []
      : [{ definition: target, kind }];
  });
};

/**
 * `reactivate`: a retired field, table or role becomes active again; a
 * field comes back optional (Contracts 1.6). A class whose parent is not
 * active stays retired.
 *
 * @param work - The application.
 * @param operation - The operation.
 */
export const reactivate = (work: Work, operation: Op<"reactivate">): void => {
  const current = checkVersion(work, operation.id, operation.version);

  const allowed =
    current === undefined
      ? undefined
      : guardChange(work, current, "reactivate");

  if (current === undefined || allowed === undefined) {
    return;
  }

  if (!RETIRABLE.has(current.kind) || current.state !== "retired") {
    unsupported(
      work,
      current.id,
      `This ${current.kind} is ${current.state} and cannot be reactivated.`
    );

    return;
  }

  const parent =
    current.kind === "class" && current.parentId !== null
      ? currentOf(work, current.parentId)
      : undefined;

  if (parent !== undefined && !isActive(parent)) {
    unsupported(
      work,
      current.id,
      `Its parent class ${parent.id} is ${parent.state}; reactivate it first.`
    );

    return;
  }

  if (
    conflict(
      work,
      current,
      "reactivate",
      inactiveTargets(viewOf(work), current)
    )
  ) {
    return;
  }

  const next = withChanges(work, current, { state: "active" });

  if (next !== undefined) {
    record(work, operation, next, note(allowed.localOverride));
  }
};

const purgedCopy = (work: Work, definition: Definition): void => {
  const next = withChanges(work, definition, { state: "purged" });

  if (next !== undefined) {
    recordCascade(work, next);
  }
};

/**
 * Whether a dependent of a purged field goes with it: a single-field
 * index, an override of the field, or one of its choices.
 *
 * @param edge - A dependent of the field.
 * @returns True when it is purged along.
 */
const goesWithField = (edge: DependentEdge): boolean => {
  const { definition, kind } = edge;

  switch (definition.kind) {
    case "index": {
      return definition.fieldIds.length === 1;
    }

    case "override": {
      return kind === "overrides";
    }

    case "choice": {
      return kind === "choice_of";
    }

    case "namespace":
    case "class":
    case "field":
    case "role":
    case "permission":
    case "grant":
    case "accessRule":
    case "subscription":
    case "layout":
    case "savedFilter":
    case "formRule":
    case "recordRule": {
      return false;
    }

    default: {
      return definition satisfies never;
    }
  }
};

const fieldPurgeBlockers = (
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  edges.filter(
    (edge) =>
      edge.kind !== "field_of" &&
      // Layout entries never block a purge (Contracts 1.7): the entry
      // stays and names a tombstone, which is skipped where it is served.
      edge.kind !== "layout_uses" &&
      edge.definition.state !== "retired" &&
      !goesWithField(edge)
  );

/**
 * The definitions a class's purge takes along: its own fields with their
 * choices, its indexes, and the overrides, layouts and saved filters
 * attached to it.
 *
 * @param view - The configuration so far.
 * @param target - The class.
 * @returns The definitions.
 */
const ownParts = (
  view: ConfigSnapshot,
  target: ClassDefinition
): readonly Definition[] => [
  ...view.ownFields(target.id),
  ...view.ownFields(target.id).flatMap((field) => view.choicesOf(field.id)),
  ...view.indexes(target.id),
  ...view.ownOverrides(target.id),
  ...view.layoutsOf(target.id),
  ...view.savedFiltersOf(target.id),
];

/** The kinds whose definitions on a table keep it from being purged. */
const ATTACHED_BEHAVIOR: ReadonlySet<Definition["kind"]> = new Set<
  Definition["kind"]
>(["accessRule", "subscription", "recordRule", "formRule"]);

/**
 * Whether a dependent of a table (or of one of its fields) keeps the table
 * from being purged: a child class, a reference field pointing at it, a
 * condition field naming it, or an access rule or subscription on it.
 *
 * @param definition - The dependent.
 * @param kind - How it depends.
 * @returns True when it blocks.
 */
const blocksTablePurge = (
  definition: Definition,
  kind: DependentEdge["kind"]
): boolean =>
  kind === "extends" ||
  NAMES_TABLE.has(kind) ||
  ATTACHED_BEHAVIOR.has(definition.kind);

const classPurgeBlockers = (
  view: ConfigSnapshot,
  target: ClassDefinition,
  edges: readonly DependentEdge[]
): readonly DependentEdge[] => {
  const own = new Set(ownParts(view, target).map((part) => part.id));

  const fieldEdges = view
    .ownFields(target.id)
    .flatMap((field) => dependentsOf(view, field.id));

  return [...edges, ...fieldEdges].filter(
    ({ definition, kind }) =>
      !own.has(definition.id) &&
      definition.id !== target.id &&
      blocksTablePurge(definition, kind)
  );
};

const purgeCascade = (
  view: ConfigSnapshot,
  current: Definition,
  edges: readonly DependentEdge[]
): readonly Definition[] => {
  if (current.kind === "class") {
    return ownParts(view, current);
  }

  return edges.flatMap((edge) =>
    goesWithField(edge) ? [edge.definition] : []
  );
};

/**
 * Checks what a purge needs besides dependents: a confirmation naming the
 * target, the `schema.purge` permission, and a target retired in an earlier
 * committed revision (the configuration the change set starts from).
 *
 * @param work - The application; a refusal is recorded there.
 * @param operation - The operation.
 * @param current - The target as the change set has left it so far.
 * @returns True when the purge may go on.
 */
const purgePreconditions = (
  work: Work,
  operation: Op<"purge">,
  current: Definition
): boolean => {
  const refusal = (reason: PurgeRefused["reason"]): boolean => {
    refuse(
      work,
      new PurgeRefused({ count: 0, definitionId: current.id, reason })
    );

    return false;
  };

  if (
    operation.confirm.id !== operation.id ||
    operation.confirm.version !== operation.version
  ) {
    return refusal("confirmation");
  }

  // Checked by the permission's stable ID; its name only labels the error.
  const permissionId = SCHEMA_PURGE_PERMISSION_ID;

  if (!hasPermission(work.snapshot, work.context.requester, permissionId)) {
    const permission = work.snapshot.get(permissionId);

    refuse(
      work,
      new PermissionRequired({
        permission:
          permission?.kind === "permission" ? permission.name : permissionId,
        permissionId,
      })
    );

    return false;
  }

  if (work.snapshot.get(current.id)?.state === "retired") {
    return true;
  }

  return refusal(
    current.state === "retired" ? "retiredInThisChangeSet" : "notRetired"
  );
};

/**
 * `purge`: a retired field or table is dropped and stays as a tombstone
 * keeping ID, last name, type and label (Contracts 1.6).
 *
 * @param work - The application.
 * @param operation - The operation.
 */
export const purge = (work: Work, operation: Op<"purge">): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  const allowed = guardChange(work, current, "purge");

  if (allowed === undefined) {
    return;
  }

  if (!PURGEABLE.has(current.kind) || current.state === "purged") {
    unsupported(
      work,
      current.id,
      `This ${current.kind} is ${current.state} and cannot be purged.`
    );

    return;
  }

  if (!purgePreconditions(work, operation, current)) {
    return;
  }

  const view = viewOf(work);
  const edges = dependentsOf(view, current.id);

  const blocking =
    current.kind === "class"
      ? classPurgeBlockers(view, current, edges)
      : fieldPurgeBlockers(edges);

  if (conflict(work, current, "purge", blocking)) {
    return;
  }

  const cascade = purgeCascade(view, current, edges);
  const next = withChanges(work, current, { state: "purged" });

  if (next === undefined) {
    return;
  }

  for (const part of cascade) {
    purgedCopy(work, part);
  }

  record(
    work,
    operation,
    next,
    note(
      allowed.localOverride,
      [],
      cascade.map((part) => part.id)
    )
  );
};

const deleteBlockers = (
  current: Definition,
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  current.kind === "role" ? roleRuleBlockers(edges, false) : [];

const deleteCascade = (
  edges: readonly DependentEdge[]
): readonly Definition[] =>
  edges.flatMap((edge) => (edge.kind === "grant_of" ? [edge.definition] : []));

/**
 * `delete`: what a generic `DELETE` of a definition record asks for
 * (Contracts 1.4, 1.7). Fields, tables and namespaces are refused with
 * `UseRetireOrPurge`; an override cannot be removed (it would loosen,
 * Contracts 2.5); everything else becomes a tombstone, and a role or
 * permission takes its grants along.
 *
 * @param work - The application.
 * @param operation - The operation.
 */
export const deleteDefinition = (work: Work, operation: Op<"delete">): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  if (NEVER_DELETED.has(current.kind)) {
    refuse(
      work,
      new UseRetireOrPurge({ definitionId: current.id, kind: current.kind })
    );

    return;
  }

  // The guard first (Contracts 1.8): a protected override is refused as
  // protected, like every other protected definition.
  if (
    current.kind === "override" &&
    guardChange(work, current, "delete") === undefined
  ) {
    return;
  }

  if (current.kind === "override" || current.state === "purged") {
    unsupported(
      work,
      current.id,
      current.kind === "override"
        ? "Removing an override would loosen the field; it cannot be deleted in v0.1."
        : "The definition is already deleted."
    );

    return;
  }

  const allowed = guardChange(work, current, "delete");

  if (allowed === undefined) {
    return;
  }

  const edges = dependentsOf(viewOf(work), current.id);

  if (conflict(work, current, "delete", deleteBlockers(current, edges))) {
    return;
  }

  const cascade = deleteCascade(edges);
  const next = withChanges(work, current, { state: "purged" });

  if (next === undefined) {
    return;
  }

  for (const part of cascade) {
    purgedCopy(work, part);
  }

  record(
    work,
    operation,
    next,
    note(
      allowed.localOverride,
      cascade.map((part) => ({ definition: part, kind: "grant_of" })),
      cascade.map((part) => part.id)
    )
  );
};

/**
 * Whether a field may be written: it is active and its class and every
 * ancestor are active (Contracts 1.6).
 *
 * @param view - The configuration.
 * @param field - A field.
 * @returns True when writes to it are accepted.
 */
export const isWritableField = (
  view: ConfigSnapshot,
  field: FieldDefinition
): boolean => isActive(field) && isActiveLineage(view, field.classId);
