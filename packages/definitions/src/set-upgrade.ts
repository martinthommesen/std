/**
 * Planning one set's load or upgrade over the config layers (Contracts 8.3,
 * 8.4): compare the set's resolved drafts with the installed shipped base
 * by ID, carry local overrides forward, and decide every case of the 8.4
 * table.
 *
 * | Case | Result |
 * | --- | --- |
 * | new record | created; a name used by a local definition refuses the set, naming it |
 * | changed, no override | applied |
 * | override exists, incoming equals `base_when_set` | nothing to do: the local value stays |
 * | incoming equals the local value | converged: override dropped, `converged` entry |
 * | local value differs | conflict: base updated, local value stays effective, conflict opened |
 * | renamed | applied by ID (roles and permissions now; tables and fields through the lifecycle operations) |
 * | removed upstream | access rules deactivated, subscriptions disabled, everything else retired through the lifecycle operations; local dependents reported; a role an active access rule names refuses the set |
 * | type changed | refused |
 *
 * Planning is pure: it returns the operations of the set's change set, the
 * layer-table writes that go into the same transaction, the report, and the
 * layer state afterwards (so `--plan` can chain sets in memory). Downgrades
 * are refused; a set whose content and version are unchanged plans
 * nothing, so a rerun changes nothing.
 */
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isSuccess } from "effect/Result";

import { applyOperations } from "./apply.ts";
import type { AppliedChangeSet, ApplyError } from "./apply.ts";
import type { Definition, FieldDefinition, Owner } from "./definition.ts";
import { dependenciesOf } from "./dependencies.ts";
import { effectiveJson } from "./effective-json.ts";
import type { DefinitionId } from "./ids.ts";
import { overridesByRecord, sameJson, shippedOf } from "./layers.ts";
import type {
  BaseRecord,
  InstalledSet,
  LayerState,
  LocalOverride,
} from "./layers.ts";
import { UPDATABLE } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { setOrigin, SYSTEM_REQUESTER } from "./requester.ts";
import {
  createOperation,
  draftDependencies,
  phaseOf,
  topologicalOrder,
} from "./set-plan.ts";
import type { OrderItem } from "./set-plan.ts";
import type { Draft, ResolvedSet } from "./set-resolve.ts";
import type { ConfigSnapshot, SnapshotKey } from "./snapshot.ts";
import { displayName } from "./upgrade-report.ts";
import type {
  ChangeAction,
  ConflictReport,
  ConvergedReport,
  DependentReport,
  KeptReport,
  RecordChange,
  Refusal,
  RefusalCode,
  RemovalReport,
  SecurityChange,
  SetReport,
} from "./upgrade-report.ts";

/**
 * Lifecycle operations of the schema engine (workstream 1A) that upgrades
 * need: retiring what a set removed, renaming tables and fields, and
 * reactivating a retired definition a set ships again. Each returns the
 * operation, or undefined while the engine does not support it for that
 * definition, which refuses the set at plan time.
 */
export interface LifecycleOperations {
  readonly retire?: (definition: Definition) => Operation | undefined;
  readonly rename?: (
    definition: Definition,
    name: string
  ) => Operation | undefined;
  readonly reactivate?: (definition: Definition) => Operation | undefined;
}

/** No lifecycle operations: every retire, rename and reactivation is refused. */
export const NO_LIFECYCLE: LifecycleOperations = {};

/** What one set's upgrade plans. */
export interface SetUpgradeInput {
  readonly resolved: ResolvedSet;
  /** SHA-256 of the resolved set (`setHash` on the server). */
  readonly hash: string;
  /** The effective configuration before the set. */
  readonly installed: ConfigSnapshot;
  /** The config layer tables before the set. */
  readonly layers: LayerState;
  /** The state of the in-memory result. */
  readonly key: SnapshotKey;
  readonly lifecycle?: LifecycleOperations;
}

/** One override to delete. */
export interface DroppedOverride {
  readonly recordId: DefinitionId;
  readonly property: string;
}

/** The layer-table writes of a set's change set. */
export interface LayerWrites {
  /** The `core.config_set` row to write, or undefined when unchanged. */
  readonly set: InstalledSet | undefined;
  /** `core.config_base` rows to insert or replace. */
  readonly base: readonly BaseRecord[];
  /** Overrides to delete (converged). */
  readonly dropOverrides: readonly DroppedOverride[];
  /** Conflicts to open. */
  readonly conflicts: readonly ConflictReport[];
  /** `converged` entries to record. */
  readonly converged: readonly ConvergedReport[];
}

/** The plan of one set. */
export interface SetUpgrade {
  readonly report: SetReport;
  /** The change set's operations: creates and changes by phase, then removals in reverse. */
  readonly operations: readonly Operation[];
  readonly writes: LayerWrites;
  /** The operations applied in memory; null when the set is refused. */
  readonly applied: AppliedChangeSet | null;
  /** The layer tables after the set. */
  readonly layersAfter: LayerState;
}

/**
 * Whether a set's change set writes layer tables.
 *
 * @param writes - The writes.
 * @returns True when any row changes.
 */
export const hasLayerWrites = (writes: LayerWrites): boolean => {
  const rows =
    writes.base.length +
    writes.dropOverrides.length +
    writes.conflicts.length +
    writes.converged.length;

  return writes.set !== undefined || rows > 0;
};

type Subject = Definition | Draft;

/** Properties being assembled for a definition (effective values or changes). */
interface EditableProperties {
  [property: string]: JsonValue;
}

/** Mutable bookkeeping of one plan; report entries are named at the end. */
interface Planning {
  readonly input: SetUpgradeInput;
  readonly lifecycle: LifecycleOperations;
  readonly overrides: ReadonlyMap<
    DefinitionId,
    ReadonlyMap<string, LocalOverride>
  >;
  readonly drafts: ReadonlyMap<DefinitionId, Draft>;
  readonly operations: Operation[];
  readonly removals: Operation[];
  readonly base: BaseRecord[];
  readonly drops: DroppedOverride[];
  readonly conflicts: {
    readonly subject: Subject;
    readonly property: string;
    readonly oldShipped: JsonValue;
    readonly newShipped: JsonValue;
    readonly local: JsonValue;
  }[];
  readonly converged: {
    readonly subject: Subject;
    readonly property: string;
    readonly oldShipped: JsonValue;
    readonly value: JsonValue;
  }[];
  readonly kept: KeptReport[];
  readonly changes: {
    readonly subject: Subject;
    readonly action: ChangeAction;
    readonly properties: readonly string[];
  }[];
  readonly removed: {
    readonly subject: Definition;
    readonly action: ChangeAction;
    readonly dependents: readonly {
      readonly definition: Definition;
      readonly dependency: string;
    }[];
  }[];
  readonly refusals: Refusal[];
}

/**
 * Whether changes to a kind belong in the report's security section.
 *
 * @param kind - A definition kind.
 * @returns True for access rules, roles and permission grants.
 */
const isSecurityKind = (kind: string): kind is SecurityChange["kind"] =>
  kind === "accessRule" || kind === "role" || kind === "grant";

const refuse = (
  planning: Planning,
  code: RefusalCode,
  definitionId: DefinitionId | null,
  message: string,
  details: JsonObject = {}
): void => {
  planning.refusals.push({
    code,
    definitionId,
    details,
    message,
    set: planning.input.resolved.header.name,
  });
};

const sameOwner = (left: Owner, right: Owner): boolean =>
  left.layer === "app" && right.layer === "app"
    ? left.setId === right.setId
    : left.layer === right.layer;

const isLocal = (
  definition: Definition | undefined
): definition is Definition =>
  definition !== undefined && definition.owner.layer === "local";

/**
 * The installed class whose hierarchy a new field joins: its own class, or
 * the nearest installed ancestor of a class the set creates.
 *
 * @param planning - The plan.
 * @param classId - The field's class.
 * @returns An installed class ID, or undefined for a new hierarchy.
 */
const installedScope = (
  planning: Planning,
  classId: DefinitionId
): DefinitionId | undefined => {
  const { installed } = planning.input;
  const seen = new Set<DefinitionId>();
  let current: DefinitionId | null = classId;

  while (current !== null && !seen.has(current)) {
    seen.add(current);

    if (installed.class(current) !== undefined) {
      return current;
    }

    const draft = planning.drafts.get(current);
    current = draft?.kind === "class" ? draft.parentId : null;
  }

  return undefined;
};

const namespaceName = (
  planning: Planning,
  namespaceId: DefinitionId
): string | undefined => {
  const draft = planning.drafts.get(namespaceId);

  return draft?.kind === "namespace"
    ? draft.name
    : planning.input.installed.namespace(namespaceId)?.name;
};

/**
 * The local definition whose name a new shipped record would take
 * (Contracts 1.8, 8.4), if any.
 *
 * @param planning - The plan.
 * @param draft - The new record.
 * @returns The clashing local definition, or undefined.
 */
const localClash = (
  planning: Planning,
  draft: Draft
): Definition | undefined => {
  const { installed } = planning.input;

  if (draft.kind === "namespace") {
    return [installed.namespaceByName(draft.name)].find(isLocal);
  }

  if (draft.kind === "class") {
    const namespace = namespaceName(planning, draft.namespaceId);

    return namespace === undefined
      ? undefined
      : [installed.classByName(`${namespace}.${draft.name}`)].find(isLocal);
  }

  if (draft.kind === "field") {
    const scope = installedScope(planning, draft.classId);

    return scope === undefined
      ? undefined
      : installed
          .hierarchyFields(scope)
          .find((field) => field.name === draft.name && isLocal(field));
  }

  if (draft.kind === "role") {
    return [installed.roleByName(draft.name)].find(isLocal);
  }

  if (draft.kind === "permission") {
    return [installed.permissionByName(draft.name)].find(isLocal);
  }

  return draft.kind === "subscription"
    ? installed
        .subscriptions()
        .find((entry) => entry.name === draft.name && isLocal(entry))
    : undefined;
};

const baseRecord = (
  planning: Planning,
  id: DefinitionId,
  kind: Definition["kind"],
  shipped: JsonObject,
  removed: boolean
): BaseRecord => ({
  id,
  kind,
  removed,
  setId: planning.input.resolved.header.id,
  setVersion: planning.input.resolved.header.version,
  shipped,
});

const noteChange = (
  planning: Planning,
  subject: Subject,
  action: ChangeAction,
  properties: readonly string[]
): void => {
  planning.changes.push({ action, properties, subject });
};

const planNew = (planning: Planning, draft: Draft): void => {
  const clash = localClash(planning, draft);

  if (clash !== undefined) {
    const name = displayName(planning.input.installed, clash);

    refuse(
      planning,
      "nameClash",
      draft.id,
      `The set adds a ${draft.kind} named "${"name" in draft ? draft.name : draft.id}", which the local ${clash.kind} ${name} (${clash.id}) already uses. Rename the local ${clash.kind} and rerun the upgrade.`,
      { localId: clash.id, localKind: clash.kind, localName: name }
    );

    return;
  }

  const shipped: JsonObject = draft;

  planning.operations.push(createOperation(draft));
  planning.base.push(
    baseRecord(planning, draft.id, draft.kind, shipped, false)
  );
  noteChange(planning, draft, "created", []);
};

const differing = (
  left: JsonObject,
  right: JsonObject,
  keys: readonly string[]
): readonly string[] =>
  keys.filter((key) => !sameJson(left[key], right[key])).toSorted();

/**
 * Carries a record's overrides across a shipped change (the 8.4 rules) and
 * returns the effective properties the record should have.
 *
 * @param planning - The plan.
 * @param draft - The incoming record.
 * @param oldShipped - The installed shipped properties.
 * @returns The target effective properties.
 */
const carryOverrides = (
  planning: Planning,
  draft: Draft,
  oldShipped: JsonObject
): JsonObject => {
  const incoming: JsonObject = draft;
  const target: EditableProperties = { ...incoming };

  for (const [property, override] of planning.overrides.get(draft.id) ??
    new Map<string, LocalOverride>()) {
    const next = incoming[property];
    const old = oldShipped[property];

    if (next === undefined || sameJson(next, old)) {
      target[property] = override.value;
    } else if (sameJson(next, override.baseWhenSet)) {
      target[property] = override.value;
      planning.kept.push({
        local: override.value,
        property,
        recordId: draft.id,
      });
    } else if (sameJson(next, override.value)) {
      planning.drops.push({ property, recordId: draft.id });
      planning.converged.push({
        oldShipped: old ?? null,
        property,
        subject: draft,
        value: next,
      });
    } else {
      target[property] = override.value;
      planning.conflicts.push({
        local: override.value,
        newShipped: next,
        oldShipped: old ?? null,
        property,
        subject: draft,
      });
    }
  }

  return target;
};

/**
 * The operations that bring an existing definition to its target effective
 * properties, or a refusal.
 *
 * @param planning - The plan.
 * @param draft - The incoming record.
 * @param current - The installed effective definition.
 * @param target - The target effective properties.
 * @returns The keys that change, or undefined after a refusal.
 */
const updateTo = (
  planning: Planning,
  draft: Draft,
  current: Definition,
  target: JsonObject
): readonly string[] | undefined => {
  const effective = effectiveJson(current);
  const keys = differing(target, effective, Object.keys(target));

  if (keys.length === 0) {
    return keys;
  }

  if (draft.kind === "override") {
    planning.operations.push({
      definition: draft,
      op: "setOverride",
      version: current.version,
    });

    return keys;
  }

  const updatable = new Set(UPDATABLE[current.kind]);
  const changes: EditableProperties = {};

  for (const key of keys) {
    const value = target[key] ?? null;

    if (updatable.has(key)) {
      changes[key] = value;
    } else if (key === "name" && isJsonString(value)) {
      const rename = planning.lifecycle.rename?.(current, value);

      if (rename === undefined) {
        refuse(
          planning,
          "renameUnsupported",
          current.id,
          `The set renames the ${current.kind} ${displayName(planning.input.installed, current)} to "${value}", which needs the schema engine's rename (workstream 1A).`
        );

        return undefined;
      }

      planning.operations.push(rename);
    } else {
      refuse(
        planning,
        "unsupportedChange",
        current.id,
        `The set changes ${key} of the ${current.kind} ${displayName(planning.input.installed, current)}, which cannot change in v0.1; add a new definition and retire this one.`,
        { property: key }
      );

      return undefined;
    }
  }

  if (Object.keys(changes).length > 0) {
    planning.operations.push({
      changes,
      id: current.id,
      op: "update",
      version: current.version,
    });
  }

  return keys;
};

const checkExisting = (
  planning: Planning,
  draft: Draft,
  current: Definition,
  target: JsonObject
): boolean => {
  const name = displayName(planning.input.installed, current);

  if (current.kind !== draft.kind || current.state === "purged") {
    refuse(
      planning,
      "unsupportedChange",
      draft.id,
      `The installed definition ${draft.id} is a ${current.state} ${current.kind}; the set ships a ${draft.kind}. IDs are never reused.`
    );

    return false;
  }

  if (current.kind === "field" && !sameJson(current.type, target.type)) {
    refuse(
      planning,
      "typeChanged",
      current.id,
      `The set changes the type of ${name}; types never change in v0.1. Add a new field and retire this one.`
    );

    return false;
  }

  if (current.state === "retired") {
    const reactivate = planning.lifecycle.reactivate?.(current);

    if (reactivate === undefined) {
      refuse(
        planning,
        "reactivationUnsupported",
        current.id,
        `The set ships the retired ${current.kind} ${name} again, which needs the schema engine's reactivation (workstream 1A).`
      );

      return false;
    }

    planning.operations.push(reactivate);
  }

  return true;
};

const planExisting = (
  planning: Planning,
  draft: Draft,
  current: Definition
): void => {
  const incoming: JsonObject = draft;
  const keys = Object.keys(incoming);
  const base = planning.input.layers.base.get(draft.id);
  const oldShipped = base?.shipped ?? shippedOf(current, keys);
  const target = carryOverrides(planning, draft, oldShipped);

  if (!checkExisting(planning, draft, current, target)) {
    return;
  }

  const changed = updateTo(planning, draft, current, target);

  if (changed === undefined) {
    return;
  }

  const shippedChanged = differing(incoming, oldShipped, keys);

  if (base === undefined || base.removed || shippedChanged.length > 0) {
    planning.base.push(
      baseRecord(planning, draft.id, draft.kind, incoming, false)
    );
  }

  const properties = shippedChanged.length > 0 ? shippedChanged : changed;

  if (properties.length > 0) {
    const renamed =
      "name" in current && !sameJson(current.name, incoming.name ?? null);

    noteChange(planning, draft, renamed ? "renamed" : "updated", properties);
  }
};

const localDependents = (
  installed: ConfigSnapshot,
  id: DefinitionId
): readonly {
  readonly definition: Definition;
  readonly dependency: string;
}[] =>
  installed
    .definitions()
    .flatMap((definition) =>
      isLocal(definition) && definition.state !== "purged"
        ? dependenciesOf(definition).flatMap((edge) =>
            edge.toId === id ? [{ definition, dependency: edge.kind }] : []
          )
        : []
    );

/**
 * Active access rules that would still name a role after this set: rules
 * the set does not remove, in the version the set ships.
 *
 * @param planning - The plan.
 * @param removedIds - What the set removes.
 * @param roleId - The role.
 * @returns The rules.
 */
const rulesNaming = (
  planning: Planning,
  removedIds: ReadonlySet<DefinitionId>,
  roleId: DefinitionId
): readonly Subject[] => {
  const installedRules = planning.input.installed
    .accessRules()
    .filter(
      (rule) =>
        !removedIds.has(rule.id) &&
        !planning.drafts.has(rule.id) &&
        rule.active &&
        rule.state === "active"
    );

  const shippedRules = [...planning.drafts.values()].filter(
    (draft) => draft.kind === "accessRule" && draft.active
  );

  return [...installedRules, ...shippedRules].filter(
    (rule) => rule.kind === "accessRule" && rule.roleIds.includes(roleId)
  );
};

/** How a removed rule or subscription is switched off. */
interface Deactivation {
  readonly op: Operation | undefined;
  readonly action: ChangeAction;
}

const deactivation = (current: Definition): Deactivation => {
  if (current.kind === "accessRule") {
    return {
      action: "deactivated",
      op: current.active
        ? {
            changes: { active: false },
            id: current.id,
            op: "update",
            version: current.version,
          }
        : undefined,
    };
  }

  return {
    action: "disabled",
    op:
      current.kind === "subscription" && current.enabled
        ? {
            changes: { enabled: false },
            id: current.id,
            op: "update",
            version: current.version,
          }
        : undefined,
  };
};

/**
 * Whether a field's type names a table the set removes: a reference's
 * target or a condition field's class. Such a field keeps that table from
 * being retired while it is active (Contracts 1.7), its own table included.
 *
 * @param field - A field.
 * @param removedIds - The definitions the set removes.
 * @returns True when it names a removed table.
 */
const namesRemovedTable = (
  field: FieldDefinition,
  removedIds: ReadonlySet<DefinitionId>
): boolean => {
  const { type } = field;

  if (type.kind === "reference") {
    return removedIds.has(type.targetClassId);
  }

  return type.kind === "condition" && removedIds.has(type.classId);
};

const planRemoval = (
  planning: Planning,
  current: Definition,
  removedIds: ReadonlySet<DefinitionId>
): void => {
  const { installed } = planning.input;
  const name = displayName(installed, current);

  if (current.kind === "accessRule" || current.kind === "subscription") {
    const { action, op } = deactivation(current);

    if (op !== undefined) {
      planning.removals.push(op);
    }

    planning.removed.push({
      action,
      dependents: localDependents(installed, current.id),
      subject: current,
    });

    return;
  }

  if (current.kind === "role") {
    const rules = rulesNaming(planning, removedIds, current.id);

    if (rules.length > 0) {
      refuse(
        planning,
        "roleInUse",
        current.id,
        `The set removes the role ${name}, which active access rules still name: ${rules.map((rule) => displayName(installed, rule)).join("; ")}. Change or deactivate those rules first.`,
        { rules: rules.map((rule) => rule.id) }
      );

      return;
    }
  }

  // A field of a table the set removes too goes with its table: the
  // table's retirement leaves its fields unwritable and unselected
  // (decision 0011), while retiring the field alone is refused as long as
  // the table names it as its display field (Contracts 1.7). Fields that
  // would keep a removed table from being retired (a reference or a
  // condition field naming a removed table, its own included) are retired
  // explicitly, before the tables (removal order: fields first).
  const goesWithItsTable =
    current.kind === "field" &&
    removedIds.has(current.classId) &&
    !namesRemovedTable(current, removedIds);

  if (current.state !== "retired" && !goesWithItsTable) {
    const retire = planning.lifecycle.retire?.(current);

    if (retire === undefined) {
      refuse(
        planning,
        "removalUnsupported",
        current.id,
        `The set removes the ${current.kind} ${name}, which is retired through the schema engine's lifecycle operations (workstream 1A).`
      );

      return;
    }

    planning.removals.push(retire);
  }

  planning.removed.push({
    action: "retired",
    dependents: localDependents(installed, current.id),
    subject: current,
  });
};

/**
 * The items of one phase for a topological order.
 *
 * @param entries - Drafts or definitions.
 * @param phase - The phase (Contracts 8.3 step 4).
 * @returns Their IDs and dependencies.
 */
const orderItems = (
  entries: readonly Draft[],
  phase: number
): readonly OrderItem[] =>
  entries.flatMap((entry) =>
    phaseOf(entry) === phase
      ? [{ dependsOn: draftDependencies(entry), id: entry.id }]
      : []
  );

/**
 * Orders definitions the way removals run: phases in reverse, and within a
 * phase dependents before what they depend on (Contracts 8.3 step 6).
 *
 * @param definitions - The removed definitions.
 * @returns The same definitions in removal order.
 */
const removalOrder = (
  definitions: readonly Definition[]
): readonly Definition[] => {
  const byId = new Map(definitions.map((entry) => [entry.id, entry]));

  return [5, 4, 3, 2, 1].flatMap((phase) =>
    topologicalOrder(orderItems(definitions, phase))
      .order.toReversed()
      .flatMap((id) => {
        const found = byId.get(id);

        return found === undefined ? [] : [found];
      })
  );
};

const planRemovals = (planning: Planning, owner: Owner): void => {
  const { installed, layers } = planning.input;

  const removed = installed
    .definitions()
    .filter(
      (definition) =>
        sameOwner(definition.owner, owner) &&
        definition.state !== "purged" &&
        !planning.drafts.has(definition.id) &&
        layers.base.get(definition.id)?.removed !== true
    );

  const removedIds = new Set(removed.map((entry) => entry.id));

  for (const definition of removalOrder(removed)) {
    const failures = planning.refusals.length;

    planRemoval(planning, definition, removedIds);

    if (planning.refusals.length === failures) {
      const json = effectiveJson(definition);

      const shipped =
        layers.base.get(definition.id)?.shipped ??
        shippedOf(
          definition,
          Object.keys(json).filter((key) => key !== "state")
        );

      planning.base.push(
        baseRecord(planning, definition.id, definition.kind, shipped, true)
      );
    }
  }
};

const planDrafts = (planning: Planning): void => {
  const { drafts } = planning.input.resolved;

  for (const phase of [1, 2, 3, 4, 5]) {
    const { order, cyclic } = topologicalOrder(orderItems(drafts, phase));

    if (cyclic.length > 0) {
      refuse(
        planning,
        "invalid",
        cyclic[0] ?? null,
        `These definitions depend on each other in a cycle: ${cyclic.join(", ")}.`,
        { problem: "extendsCycle" }
      );
    }

    for (const id of order) {
      const draft = planning.drafts.get(id);
      const current = planning.input.installed.get(id);

      if (draft !== undefined) {
        if (current === undefined) {
          planNew(planning, draft);
        } else {
          planExisting(planning, draft, current);
        }
      }
    }
  }
};

const setRowOf = (input: SetUpgradeInput): InstalledSet | undefined => {
  const { header } = input.resolved;
  const installed = input.layers.sets.get(header.id);

  const next: InstalledSet = {
    hash: input.hash,
    id: header.id,
    layer: header.layer,
    name: header.name,
    requires: header.requires ?? [],
    version: header.version,
  };

  if (installed === undefined) {
    return next;
  }

  const same =
    sameJson(installed.hash, next.hash) &&
    sameJson(installed.version, next.version) &&
    sameJson([installed.name, installed.requires], [next.name, next.requires]);

  return same ? undefined : next;
};

const newPlanning = (input: SetUpgradeInput): Planning => ({
  base: [],
  changes: [],
  conflicts: [],
  converged: [],
  drafts: new Map(input.resolved.drafts.map((draft) => [draft.id, draft])),
  drops: [],
  input,
  kept: [],
  lifecycle: input.lifecycle ?? NO_LIFECYCLE,
  operations: [],
  overrides: overridesByRecord(input.layers.overrides),
  refusals: [],
  removals: [],
  removed: [],
});

const layersAfter = (
  input: SetUpgradeInput,
  writes: LayerWrites
): LayerState => {
  const sets = new Map(input.layers.sets);
  const base = new Map(input.layers.base);

  if (writes.set !== undefined) {
    sets.set(writes.set.id, writes.set);
  }

  for (const record of writes.base) {
    base.set(record.id, record);
  }

  const dropped = new Set(
    writes.dropOverrides.map((entry) => `${entry.recordId}/${entry.property}`)
  );

  return {
    base,
    overrides: input.layers.overrides.filter(
      (entry) => !dropped.has(`${entry.recordId}/${entry.property}`)
    ),
    sets,
  };
};

const reportOf = (
  planning: Planning,
  named: ConfigSnapshot,
  writes: LayerWrites
): SetReport => {
  const { input } = planning;
  const { header } = input.resolved;
  const installed = input.layers.sets.get(header.id);
  const name = (subject: Subject): string => displayName(named, subject);

  const changes: RecordChange[] = planning.changes.map((entry) => ({
    action: entry.action,
    id: entry.subject.id,
    kind: entry.subject.kind,
    name: name(entry.subject),
    properties: entry.properties,
  }));

  const removed: RemovalReport[] = planning.removed.map((entry) => ({
    action: entry.action,
    id: entry.subject.id,
    kind: entry.subject.kind,
    localDependents: entry.dependents.map((dependent): DependentReport => ({
      dependency: dependent.dependency,
      id: dependent.definition.id,
      kind: dependent.definition.kind,
      name: name(dependent.definition),
    })),
    name: name(entry.subject),
  }));

  const security: SecurityChange[] = [
    ...changes.map((entry) => ({ ...entry, change: entry.action })),
    ...removed.map((entry) => ({
      ...entry,
      change: entry.action === "retired" ? ("removed" as const) : entry.action,
      properties: [],
    })),
  ].flatMap((entry): SecurityChange[] =>
    isSecurityKind(entry.kind)
      ? [
          {
            change: entry.change,
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            properties: entry.properties,
          },
        ]
      : []
  );

  return {
    changes,
    conflicts: writes.conflicts,
    contentChangedWithoutVersion:
      installed !== undefined &&
      installed.version === header.version &&
      installed.hash !== input.hash,
    converged: writes.converged,
    fromVersion: installed?.version ?? null,
    hash: input.hash,
    id: header.id,
    kept: planning.kept,
    layer: header.layer,
    name: header.name,
    operations: planning.operations.length + planning.removals.length,
    refusals: planning.refusals,
    removed,
    security,
    toVersion: header.version,
  };
};

const writesOf = (planning: Planning, named: ConfigSnapshot): LayerWrites => ({
  base: planning.base,
  conflicts: planning.conflicts.map((entry) => ({
    kind: entry.subject.kind,
    local: entry.local,
    name: displayName(named, entry.subject),
    newShipped: entry.newShipped,
    oldShipped: entry.oldShipped,
    property: entry.property,
    recordId: entry.subject.id,
  })),
  converged: planning.converged.map((entry) => ({
    kind: entry.subject.kind,
    name: displayName(named, entry.subject),
    oldShipped: entry.oldShipped,
    property: entry.property,
    recordId: entry.subject.id,
    value: entry.value,
  })),
  dropOverrides: planning.drops,
  set: setRowOf(planning.input),
});

/**
 * Records why applying the planned operations failed: each validation
 * problem, or the schema engine's lifecycle refusal (a dependent that
 * blocks a retire, a protected definition), with the error's tag.
 *
 * @param planning - The plan.
 * @param failure - The failure of `applyOperations`.
 */
const refuseApplyError = (planning: Planning, failure: ApplyError): void => {
  if (failure._tag !== "DefinitionInvalid") {
    refuse(
      planning,
      "lifecycleRefused",
      "definitionId" in failure ? failure.definitionId : null,
      failure.message,
      { error: failure._tag }
    );

    return;
  }

  for (const found of failure.problems) {
    refuse(planning, "invalid", found.definitionId, found.message, {
      problem: found.code,
    });
  }
};

/**
 * Plans one set over the installed configuration and layer tables.
 *
 * @param input - The resolved set, its hash, and the installed state.
 * @returns The set's operations, layer writes, report and the layer state
 *   after it. Refusals are in `report.refusals`; a refused set has no
 *   `applied`.
 */
export const planSetUpgrade = (input: SetUpgradeInput): SetUpgrade => {
  const planning = newPlanning(input);
  const { header, owner } = input.resolved;
  const installedSet = input.layers.sets.get(header.id);

  if (installedSet !== undefined && header.version < installedSet.version) {
    refuse(
      planning,
      "downgrade",
      header.id,
      `The set ${header.name} is installed at version ${installedSet.version}; version ${header.version} would be a downgrade, which is refused.`,
      { incoming: header.version, installed: installedSet.version }
    );
  } else {
    planDrafts(planning);
    planRemovals(planning, owner);
  }

  const operations = [...planning.operations, ...planning.removals];

  const applied =
    planning.refusals.length === 0
      ? applyOperations(input.installed, operations, input.key, {
          origin: setOrigin(owner),
          requester: SYSTEM_REQUESTER,
        })
      : undefined;

  if (applied !== undefined && !isSuccess(applied)) {
    refuseApplyError(planning, applied.failure);
  }

  const success =
    applied !== undefined && isSuccess(applied) ? applied.success : null;

  const named = success?.after ?? input.installed;
  const writes = writesOf(planning, named);

  return {
    applied: success,
    layersAfter: layersAfter(input, writes),
    operations,
    report: reportOf(planning, named, writes),
    writes,
  };
};
