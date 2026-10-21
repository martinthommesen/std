/**
 * The reverse of the dependency index (Contracts 1.7): which live
 * definitions refer to a definition, and how. Dependency checks read only
 * configuration, and the snapshot is the configuration the change set runs
 * at (loaded under `CONFIG_KEY` in the main transaction), so this equals
 * reading `core.config_dependency`, which `doctor` recomputes the same way.
 */
import type { Definition } from "./definition.ts";
import { isLive } from "./definition.ts";
import { dependenciesOf } from "./dependencies.ts";
import type { DependencyKind } from "./dependencies.ts";
import type { Dependent } from "./dependency-conflict.ts";
import type { DefinitionId } from "./ids.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** A live definition that refers to another one. */
export interface DependentEdge {
  readonly definition: Definition;
  readonly kind: DependencyKind;
}

const indexes = new WeakMap<
  ConfigSnapshot,
  ReadonlyMap<DefinitionId, readonly DependentEdge[]>
>();

const reverseIndex = (
  snapshot: ConfigSnapshot
): ReadonlyMap<DefinitionId, readonly DependentEdge[]> => {
  const cached = indexes.get(snapshot);

  if (cached !== undefined) {
    return cached;
  }

  const built = new Map<DefinitionId, DependentEdge[]>();

  for (const definition of snapshot.definitions()) {
    for (const edge of isLive(definition) ? dependenciesOf(definition) : []) {
      const list = built.get(edge.toId) ?? [];

      list.push({ definition, kind: edge.kind });
      built.set(edge.toId, list);
    }
  }

  indexes.set(snapshot, built);

  return built;
};

/**
 * The live definitions that refer to a definition.
 *
 * @param snapshot - The configuration.
 * @param id - The definition referred to.
 * @returns Each referring definition with the dependency kind, in snapshot
 *   order (kind, then ID); one entry per kind.
 */
export const dependentsOf = (
  snapshot: ConfigSnapshot,
  id: DefinitionId
): readonly DependentEdge[] => reverseIndex(snapshot).get(id) ?? [];

/**
 * A definition's name as reports show it: its name, an access rule's
 * description, or null.
 *
 * @param definition - Any definition.
 * @returns The name.
 */
export const displayNameOf = (definition: Definition): string | null => {
  if ("name" in definition) {
    return definition.name;
  }

  return definition.kind === "accessRule" ? definition.description : null;
};

/**
 * Describes a dependent for a refusal or a report.
 *
 * @param edge - The dependent and its dependency kind.
 * @returns ID, kind, name and dependency kind.
 */
export const describeDependent = (edge: DependentEdge): Dependent => ({
  dependency: edge.kind,
  id: edge.definition.id,
  kind: edge.definition.kind,
  name: displayNameOf(edge.definition),
});
