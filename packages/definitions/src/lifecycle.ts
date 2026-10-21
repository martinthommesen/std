/**
 * Lifecycle operations applied in memory (Contracts 1.1, 1.6, 1.7, 1.8):
 * rename, retire, reactivate, purge and delete, with the protected-
 * definition guard, the dependency checks of the 1.7 table and the
 * definitions they take along (cascades).
 *
 * | Operation | Refused when (blocking dependents) | Reported but allowed | Cascade |
 * | --- | --- | --- | --- |
 * | rename | protected; core or app owned and not its set; the new name is in use before this change set | nothing | none |
 * | retire field | protected; display field of a class; part of a multi-field unique index | other dependents | none (`required` becomes false) |
 * | retire table | protected; an active child class; an active reference field on an active table points at it | other dependents | none |
 * | retire role | protected; an active access rule names it | other dependents | none |
 * | purge field | not retired before this change set; any dependent that is not retired, except single-field indexes and overrides | none | its single-field indexes and overrides |
 * | purge table | not retired before; a child class or incoming reference field not purged; an access rule or subscription on it | none | its fields, indexes and overrides |
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
import { PERMISSION_IDS } from "./well-known.ts";

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

  if (!(RENAMABLE.has(current.kind) && isLive(current))) {
    unsupported(
      work,
      current.id,
      `A ${current.kind} ${current.state === "purged" ? "tombstone " : ""}cannot be renamed.`
    );

    return;
  }

  const allowed = guardChange(work, current, "rename");

  if (allowed === undefined) {
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

const retireFieldBlockers = (
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  edges.filter(
    (edge) =>
      (edge.kind === "display_field" && isLive(edge.definition)) ||
      isMultiFieldUnique(edge)
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

const retireClassBlockers = (
  view: ConfigSnapshot,
  target: ClassDefinition,
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  edges.filter(({ definition, kind }) => {
    if (kind === "extends") {
      return isActive(definition);
    }

    if (kind !== "references_table" || definition.kind !== "field") {
      return false;
    }

    return (
      isActive(definition) &&
      definition.classId !== target.id &&
      isActiveLineage(view, definition.classId)
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
  view: ConfigSnapshot,
  current: Definition,
  edges: readonly DependentEdge[]
): readonly DependentEdge[] => {
  if (current.kind === "field") {
    return retireFieldBlockers(edges);
  }

  if (current.kind === "class") {
    return retireClassBlockers(view, current, edges);
  }

  return roleRuleBlockers(edges, true);
};

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

  if (!RETIRABLE.has(current.kind) || !isActive(current)) {
    unsupported(
      work,
      current.id,
      `This ${current.kind} is ${current.state} and cannot be retired.`
    );

    return;
  }

  const allowed = guardChange(work, current, "retire");

  if (allowed === undefined) {
    return;
  }

  const view = viewOf(work);
  const edges = dependentsOf(view, current.id);
  const blocking = blockersForRetire(view, current, edges);
  const blockingSet = new Set(blocking);

  if (conflict(work, current, "retire", blocking)) {
    return;
  }

  const next = withChanges(work, current, retiredState(current));

  if (next !== undefined) {
    record(
      work,
      operation,
      next,
      note(
        allowed.localOverride,
        edges.filter((edge) => !blockingSet.has(edge))
      )
    );
  }
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

  if (current === undefined) {
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

  const allowed = guardChange(work, current, "reactivate");

  const next =
    allowed === undefined
      ? undefined
      : withChanges(work, current, { state: "active" });

  if (allowed !== undefined && next !== undefined) {
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
 * index, or an override of the field.
 *
 * @param edge - A dependent of the field.
 * @returns True when it is purged along.
 */
const goesWithField = (edge: DependentEdge): boolean =>
  (edge.definition.kind === "index" && edge.definition.fieldIds.length === 1) ||
  (edge.definition.kind === "override" && edge.kind === "overrides");

const fieldPurgeBlockers = (
  edges: readonly DependentEdge[]
): readonly DependentEdge[] =>
  edges.filter(
    (edge) =>
      edge.kind !== "field_of" &&
      edge.definition.state !== "retired" &&
      !goesWithField(edge)
  );

/**
 * The definitions a class's purge takes along: its own fields, its
 * indexes, and the overrides attached to it.
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
  ...view.indexes(target.id),
  ...view.ownOverrides(target.id),
];

/**
 * Whether a dependent of a table (or of one of its fields) keeps the table
 * from being purged: a child class, a reference field pointing at it, or an
 * access rule or subscription on it.
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
  kind === "references_table" ||
  definition.kind === "accessRule" ||
  definition.kind === "subscription";

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

  const permissionId = PERMISSION_IDS["schema.purge"];

  if (!hasPermission(work.snapshot, work.context.requester, permissionId)) {
    refuse(
      work,
      new PermissionRequired({ permission: "schema.purge", permissionId })
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

  if (!PURGEABLE.has(current.kind) || current.state === "purged") {
    unsupported(
      work,
      current.id,
      `This ${current.kind} is ${current.state} and cannot be purged.`
    );

    return;
  }

  const allowed = guardChange(work, current, "purge");

  if (allowed === undefined || !purgePreconditions(work, operation, current)) {
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
