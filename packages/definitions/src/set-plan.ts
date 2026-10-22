/**
 * Planning a set load (Contracts 8.3 steps 3 to 5): compare the resolved
 * drafts with the installed definitions by ID, turn the differences into
 * operations, and order them in phases and topologically, ties broken by
 * ID, so the generated SQL is the same for any file order:
 *
 * 1. namespaces, tables (parents first) and their non-reference fields;
 * 2. reference fields (whose FKs may point at any table of phase 1);
 * 3. indexes and overrides;
 * 4. roles, permissions and grants;
 * 5. access rules, subscriptions, choices and layouts.
 *
 * An unchanged set plans no operation. Removals and changes that need a
 * new set version's upgrade rules (renames, type changes, retire) belong to
 * workstream 1B and are refused here.
 */
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { fail, succeed } from "effect/Result";
import type { Result } from "effect/Result";

import type { Definition } from "./definition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import { UPDATABLE } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { DefinitionInvalid, problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import type { Draft, ResolvedSet } from "./set-resolve.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** The phase of each kind; reference fields move to phase 2. */
const PHASES: Readonly<Record<Draft["kind"], number>> = {
  accessRule: 5,
  choice: 5,
  class: 1,
  field: 1,
  grant: 4,
  index: 3,
  layout: 5,
  namespace: 1,
  override: 3,
  permission: 4,
  role: 4,
  subscription: 5,
};

/** The phase of reference fields. */
const REFERENCE_PHASE = 2;

/**
 * The phase of a draft (Contracts 8.3 step 4).
 *
 * @param draft - A draft.
 * @returns 1 to 5.
 */
export const phaseOf = (draft: Draft): number =>
  draft.kind === "field" && draft.type.kind === "reference"
    ? REFERENCE_PHASE
    : PHASES[draft.kind];

/**
 * The IDs a draft depends on, for the topological order.
 *
 * @param draft - A draft.
 * @returns The IDs it refers to.
 */
export const draftDependencies = (draft: Draft): readonly DefinitionId[] => {
  if (draft.kind === "class") {
    return draft.parentId === null
      ? [draft.namespaceId]
      : [draft.namespaceId, draft.parentId];
  }

  if (draft.kind === "field") {
    return draft.type.kind === "reference"
      ? [draft.classId, draft.type.targetClassId]
      : [draft.classId];
  }

  if (draft.kind === "index") {
    return [draft.classId, ...draft.fieldIds];
  }

  if (draft.kind === "override") {
    return [draft.classId, draft.fieldId];
  }

  if (draft.kind === "grant") {
    return [draft.roleId, draft.permissionId];
  }

  if (draft.kind === "accessRule") {
    return draft.classId === null
      ? draft.roleIds
      : [draft.classId, ...draft.roleIds];
  }

  if (draft.kind === "choice") {
    return [draft.fieldId];
  }

  if (draft.kind === "layout") {
    return [
      draft.classId,
      ...draft.elements.flatMap((element) =>
        element.kind === "field" ? [element.fieldId] : []
      ),
    ];
  }

  return draft.kind === "subscription" ? [draft.classId] : [];
};

/** One item to order, with the IDs it depends on. */
export interface OrderItem {
  readonly id: DefinitionId;
  readonly dependsOn: readonly DefinitionId[];
}

/** The result of a topological order. */
export interface TopologicalOrder {
  readonly order: readonly DefinitionId[];
  /** IDs left over because they depend on each other in a cycle. */
  readonly cyclic: readonly DefinitionId[];
}

/**
 * Orders items so every item comes after the items it depends on, taking
 * the smallest available ID first (Kahn's algorithm). Dependencies outside
 * the list are ignored.
 *
 * @param items - IDs with their dependencies.
 * @returns The order, and the IDs left in a cycle.
 */
export const topologicalOrder = (
  items: readonly OrderItem[]
): TopologicalOrder => {
  const ids = new Set(items.map((item) => item.id));
  const pending = new Map<DefinitionId, Set<DefinitionId>>();
  const dependents = new Map<DefinitionId, DefinitionId[]>();

  for (const item of items) {
    const deps = new Set(
      item.dependsOn.filter((dep) => ids.has(dep) && dep !== item.id)
    );

    pending.set(item.id, deps);

    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), item.id]);
    }
  }

  const ready = [...pending.entries()].flatMap(([id, deps]) =>
    deps.size === 0 ? [id] : []
  );

  const order: DefinitionId[] = [];

  while (ready.length > 0) {
    ready.sort(compareIds);
    const next = ready.shift();

    if (next === undefined) {
      break;
    }

    order.push(next);
    pending.delete(next);

    for (const dependent of dependents.get(next) ?? []) {
      const deps = pending.get(dependent);
      deps?.delete(next);

      if (deps?.size === 0) {
        ready.push(dependent);
      }
    }
  }

  return { cyclic: [...pending.keys()].toSorted(compareIds), order };
};

const jsonText = (value: JsonValue | undefined): string =>
  stringifyJson(value ?? null);

/**
 * The operation that creates a draft's definition.
 *
 * @param draft - A draft.
 * @returns Its create operation (`setOverride` with version null for an override).
 */
export const createOperation = (draft: Draft): Operation => {
  if (draft.kind === "namespace") {
    return { definition: draft, op: "createNamespace" };
  }

  if (draft.kind === "class") {
    return { definition: draft, op: "createClass" };
  }

  if (draft.kind === "field") {
    return { definition: draft, op: "addField" };
  }

  if (draft.kind === "index") {
    return { definition: draft, op: "addIndex" };
  }

  if (draft.kind === "override") {
    return { definition: draft, op: "setOverride", version: null };
  }

  if (draft.kind === "role") {
    return { definition: draft, op: "createRole" };
  }

  if (draft.kind === "permission") {
    return { definition: draft, op: "createPermission" };
  }

  if (draft.kind === "grant") {
    return { definition: draft, op: "createGrant" };
  }

  if (draft.kind === "choice") {
    return { definition: draft, op: "createChoice" };
  }

  if (draft.kind === "layout") {
    return { definition: draft, op: "createLayout" };
  }

  return draft.kind === "accessRule"
    ? { definition: draft, op: "createAccessRule" }
    : { definition: draft, op: "createSubscription" };
};

const differingKeys = (
  draft: JsonObject,
  stored: JsonObject
): readonly string[] =>
  Object.entries(draft)
    .flatMap(([key, value]) =>
      jsonText(value) === jsonText(stored[key]) ? [] : [key]
    )
    .toSorted();

const planDraft = (
  draft: Draft,
  stored: Definition | undefined,
  problems: DefinitionProblem[]
): Operation | undefined => {
  if (stored === undefined) {
    return createOperation(draft);
  }

  if (stored.kind !== draft.kind) {
    problems.push(
      problem(
        "wrongKind",
        draft.id,
        `The installed definition ${draft.id} is a ${stored.kind}, not a ${draft.kind}.`
      )
    );

    return undefined;
  }

  if (stored.state !== "active") {
    problems.push(
      problem(
        "unsupportedChange",
        draft.id,
        `The installed definition ${draft.id} is ${stored.state}; reactivation comes with workstream 1A.`
      )
    );

    return undefined;
  }

  const draftJson: JsonObject = draft;
  const keys = differingKeys(draftJson, stored);

  if (keys.length === 0) {
    return undefined;
  }

  if (draft.kind === "override") {
    return { definition: draft, op: "setOverride", version: stored.version };
  }

  const updatable = new Set(UPDATABLE[draft.kind]);
  const refused = keys.filter((key) => !updatable.has(key));

  if (refused.length > 0) {
    problems.push(
      problem(
        "unsupportedChange",
        draft.id,
        `The set changes ${refused.join(", ")} of ${draft.id}, which needs the upgrade rules of workstream 1B.`
      )
    );

    return undefined;
  }

  return {
    changes: Object.fromEntries(
      keys.map((key) => [key, draftJson[key] ?? null])
    ),
    id: draft.id,
    op: "update",
    version: stored.version,
  };
};

/**
 * Plans the operations that bring the installed configuration to the set.
 *
 * @param resolved - The resolved set.
 * @param installed - The installed configuration.
 * @returns The ordered operations (empty when nothing changed), or every
 *   problem found.
 */
export const planSet = (
  resolved: ResolvedSet,
  installed: ConfigSnapshot
): Result<readonly Operation[], DefinitionInvalid> => {
  const problems: DefinitionProblem[] = [];
  const drafts = new Map(resolved.drafts.map((draft) => [draft.id, draft]));
  const operations: Operation[] = [];
  const phases = [1, 2, 3, 4, 5] as const;

  for (const phase of phases) {
    const members = resolved.drafts.filter((draft) => phaseOf(draft) === phase);

    const { order, cyclic } = topologicalOrder(
      members.map((draft) => ({
        dependsOn: draftDependencies(draft),
        id: draft.id,
      }))
    );

    if (cyclic.length > 0) {
      problems.push(
        problem(
          "extendsCycle",
          cyclic[0] ?? null,
          `These definitions depend on each other in a cycle: ${cyclic.join(", ")}.`
        )
      );
    }

    for (const id of order) {
      const draft = drafts.get(id);

      const operation =
        draft === undefined
          ? undefined
          : planDraft(draft, installed.get(id), problems);

      if (operation !== undefined) {
        operations.push(operation);
      }
    }
  }

  return problems.length > 0
    ? fail(new DefinitionInvalid({ problems }))
    : succeed(operations);
};
