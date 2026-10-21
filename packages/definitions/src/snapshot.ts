/**
 * `ConfigSnapshot`: one immutable, consistent view of all configuration at
 * a `(revision, change_set_id)` (Contracts 1.2, 1.3). Every request resolves
 * names and compiles SQL from the snapshot of its revision.
 *
 * The snapshot keeps every definition, purged tombstones included, so old
 * change entries can still be interpreted; name lookups and hierarchy
 * helpers only see live (active or retired) definitions.
 */
import type {
  AccessRuleDefinition,
  ClassDefinition,
  Definition,
  DefinitionKind,
  DefinitionOf,
  FieldDefinition,
  GrantDefinition,
  IndexDefinition,
  NamespaceDefinition,
  OverrideDefinition,
  PermissionDefinition,
  RoleDefinition,
  SubscriptionDefinition,
} from "./definition.ts";
import { DEFINITION_KINDS, isLive } from "./definition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import { qualifiedName } from "./names.ts";

/** The configuration state a snapshot belongs to. */
export interface SnapshotKey {
  readonly revision: number;
  readonly changeSetId: string;
}

/**
 * Whether a definition is of the given kind.
 *
 * @param definition - Any definition.
 * @param kind - The kind.
 * @returns True when the definition has that kind.
 */
const isKind = <K extends DefinitionKind>(
  definition: Definition,
  kind: K
): definition is DefinitionOf<K> => definition.kind === kind;

const groupByKind = (
  definitions: readonly Definition[]
): ReadonlyMap<DefinitionKind, readonly Definition[]> => {
  const groups = new Map<DefinitionKind, Definition[]>(
    DEFINITION_KINDS.map((kind) => [kind, []])
  );

  for (const definition of definitions) {
    groups.get(definition.kind)?.push(definition);
  }

  return groups;
};

const byId = (left: Definition, right: Definition): number =>
  compareIds(left.id, right.id);

const appendTo = <V>(map: Map<string, V[]>, key: string, value: V): void => {
  const list = map.get(key);

  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
};

/** An immutable view of all configuration at one revision. */
export class ConfigSnapshot implements SnapshotKey {
  readonly revision: number;
  readonly changeSetId: string;

  readonly #definitions: ReadonlyMap<DefinitionId, Definition>;
  readonly #byKind: ReadonlyMap<DefinitionKind, readonly Definition[]>;
  readonly #namespaceByName = new Map<string, NamespaceDefinition>();
  readonly #classByName = new Map<string, ClassDefinition>();
  readonly #roleByName = new Map<string, RoleDefinition>();
  readonly #permissionByName = new Map<string, PermissionDefinition>();
  readonly #children = new Map<DefinitionId, ClassDefinition[]>();
  readonly #fieldsByClass = new Map<DefinitionId, FieldDefinition[]>();
  readonly #overridesByClass = new Map<DefinitionId, OverrideDefinition[]>();
  readonly #indexesByClass = new Map<DefinitionId, IndexDefinition[]>();
  readonly #classesByNamespace = new Map<DefinitionId, ClassDefinition[]>();

  private constructor(
    key: SnapshotKey,
    definitions: ReadonlyMap<DefinitionId, Definition>
  ) {
    this.revision = key.revision;
    this.changeSetId = key.changeSetId;
    this.#definitions = definitions;
    this.#byKind = groupByKind([...definitions.values()].toSorted(byId));

    this.#index();
  }

  /**
   * Builds a snapshot. A later definition with the same ID replaces an
   * earlier one.
   *
   * @param key - The revision and change set ID.
   * @param definitions - Every definition, tombstones included.
   * @returns The snapshot.
   */
  static make(
    key: SnapshotKey,
    definitions: Iterable<Definition>
  ): ConfigSnapshot {
    const map = new Map<DefinitionId, Definition>();

    for (const definition of definitions) {
      map.set(definition.id, definition);
    }

    return new ConfigSnapshot(key, map);
  }

  /**
   * An empty snapshot, for an install without definitions.
   *
   * @param key - The revision and change set ID.
   * @returns The snapshot.
   */
  static empty(key: SnapshotKey): ConfigSnapshot {
    return new ConfigSnapshot(key, new Map());
  }

  /**
   * A snapshot with some definitions added or replaced.
   *
   * @param key - The new revision and change set ID.
   * @param changed - Definitions to add or replace.
   * @returns The new snapshot.
   */
  with(key: SnapshotKey, changed: Iterable<Definition>): ConfigSnapshot {
    const map = new Map(this.#definitions);

    for (const definition of changed) {
      map.set(definition.id, definition);
    }

    return new ConfigSnapshot(key, map);
  }

  #index(): void {
    for (const namespace of this.all("namespace").filter(isLive)) {
      this.#namespaceByName.set(namespace.name, namespace);
    }

    for (const role of this.all("role").filter(isLive)) {
      this.#roleByName.set(role.name, role);
    }

    for (const permission of this.all("permission").filter(isLive)) {
      this.#permissionByName.set(permission.name, permission);
    }

    for (const definition of this.all("class").filter(isLive)) {
      const namespace = this.namespace(definition.namespaceId);

      if (namespace !== undefined) {
        this.#classByName.set(
          qualifiedName(namespace.name, definition.name),
          definition
        );
      }

      appendTo(this.#classesByNamespace, definition.namespaceId, definition);

      if (definition.parentId !== null) {
        appendTo(this.#children, definition.parentId, definition);
      }
    }

    for (const field of this.all("field").filter(isLive)) {
      appendTo(this.#fieldsByClass, field.classId, field);
    }

    for (const override of this.all("override").filter(isLive)) {
      appendTo(this.#overridesByClass, override.classId, override);
    }

    for (const index of this.all("index").filter(isLive)) {
      appendTo(this.#indexesByClass, index.classId, index);
    }
  }

  /**
   * The configuration state of this snapshot.
   *
   * @returns The revision and change set ID.
   */
  get key(): SnapshotKey {
    return { changeSetId: this.changeSetId, revision: this.revision };
  }

  /**
   * Every definition, sorted by kind then ID.
   *
   * @returns The definitions, tombstones included.
   */
  definitions(): readonly Definition[] {
    return DEFINITION_KINDS.flatMap((kind) => this.#byKind.get(kind) ?? []);
  }

  /**
   * Every definition of one kind, sorted by ID.
   *
   * @param kind - The kind.
   * @returns The definitions, tombstones included.
   */
  all<K extends DefinitionKind>(kind: K): readonly DefinitionOf<K>[] {
    return (this.#byKind.get(kind) ?? []).filter(
      (definition): definition is DefinitionOf<K> => isKind(definition, kind)
    );
  }

  /**
   * A definition by ID.
   *
   * @param id - The ID.
   * @returns The definition, or undefined.
   */
  get(id: DefinitionId): Definition | undefined {
    return this.#definitions.get(id);
  }

  /**
   * A definition of one kind by ID.
   *
   * @param kind - The expected kind.
   * @param id - The ID.
   * @returns The definition, or undefined when missing or of another kind.
   */
  getKind<K extends DefinitionKind>(
    kind: K,
    id: DefinitionId
  ): DefinitionOf<K> | undefined {
    const definition = this.#definitions.get(id);

    return definition !== undefined && isKind(definition, kind)
      ? definition
      : undefined;
  }

  /**
   * @param id - A namespace ID.
   * @returns The namespace, or undefined.
   */
  namespace(id: DefinitionId): NamespaceDefinition | undefined {
    return this.getKind("namespace", id);
  }

  /**
   * @param id - A class ID.
   * @returns The class, or undefined.
   */
  class(id: DefinitionId): ClassDefinition | undefined {
    return this.getKind("class", id);
  }

  /**
   * @param id - A field ID.
   * @returns The field, or undefined.
   */
  field(id: DefinitionId): FieldDefinition | undefined {
    return this.getKind("field", id);
  }

  /**
   * @param id - A role ID.
   * @returns The role, or undefined.
   */
  role(id: DefinitionId): RoleDefinition | undefined {
    return this.getKind("role", id);
  }

  /**
   * @param name - A namespace name.
   * @returns The live namespace of that name, or undefined.
   */
  namespaceByName(name: string): NamespaceDefinition | undefined {
    return this.#namespaceByName.get(name);
  }

  /**
   * @param name - A qualified table name, `namespace.table`.
   * @returns The live class of that name, or undefined.
   */
  classByName(name: string): ClassDefinition | undefined {
    return this.#classByName.get(name);
  }

  /**
   * @param name - A role name.
   * @returns The live role of that name, or undefined.
   */
  roleByName(name: string): RoleDefinition | undefined {
    return this.#roleByName.get(name);
  }

  /**
   * @param name - A permission name.
   * @returns The live permission of that name, or undefined.
   */
  permissionByName(name: string): PermissionDefinition | undefined {
    return this.#permissionByName.get(name);
  }

  /**
   * The qualified name of a class.
   *
   * @param classId - A class ID.
   * @returns `namespace.table`, or undefined for an unknown class.
   */
  qualifiedNameOf(classId: DefinitionId): string | undefined {
    const definition = this.class(classId);

    const namespace =
      definition === undefined
        ? undefined
        : this.namespace(definition.namespaceId);

    return definition === undefined || namespace === undefined
      ? undefined
      : qualifiedName(namespace.name, definition.name);
  }

  /**
   * @param namespaceId - A namespace ID.
   * @returns Its live classes, sorted by ID.
   */
  classesIn(namespaceId: DefinitionId): readonly ClassDefinition[] {
    return this.#classesByNamespace.get(namespaceId) ?? [];
  }

  /**
   * The ancestors of a class, root first, without the class itself. Stops
   * at a cycle or a missing parent (validation reports both).
   *
   * @param classId - A class ID.
   * @returns The ancestors.
   */
  ancestors(classId: DefinitionId): readonly ClassDefinition[] {
    const chain: ClassDefinition[] = [];
    const seen = new Set<DefinitionId>([classId]);
    let parentId = this.class(classId)?.parentId ?? null;

    while (parentId !== null && !seen.has(parentId)) {
      const parent = this.class(parentId);

      if (parent === undefined) {
        break;
      }

      seen.add(parentId);
      chain.push(parent);
      ({ parentId } = parent);
    }

    return chain.toReversed();
  }

  /**
   * The class and its ancestors, root first.
   *
   * @param classId - A class ID.
   * @returns The lineage; empty for an unknown class.
   */
  lineage(classId: DefinitionId): readonly ClassDefinition[] {
    const definition = this.class(classId);

    return definition === undefined
      ? []
      : [...this.ancestors(classId), definition];
  }

  /**
   * The root of a class's hierarchy.
   *
   * @param classId - A class ID.
   * @returns The root class, or undefined for an unknown class.
   */
  root(classId: DefinitionId): ClassDefinition | undefined {
    return this.lineage(classId)[0];
  }

  /**
   * The depth of a class: 0 for a root.
   *
   * @param classId - A class ID.
   * @returns The number of ancestors.
   */
  depth(classId: DefinitionId): number {
    return this.ancestors(classId).length;
  }

  /**
   * @param classId - A class ID.
   * @returns Its live direct children, sorted by ID.
   */
  children(classId: DefinitionId): readonly ClassDefinition[] {
    return this.#children.get(classId) ?? [];
  }

  /**
   * `subtree(T)`: the class and all its live descendants, in depth-first
   * order with children sorted by ID.
   *
   * @param classId - A class ID.
   * @returns The subtree; empty for an unknown class.
   */
  subtree(classId: DefinitionId): readonly ClassDefinition[] {
    const start = this.class(classId);

    if (start === undefined) {
      return [];
    }

    const result: ClassDefinition[] = [];
    const seen = new Set<DefinitionId>();
    const stack: ClassDefinition[] = [start];

    while (stack.length > 0) {
      const next = stack.pop();

      if (next !== undefined && !seen.has(next.id)) {
        seen.add(next.id);
        result.push(next);
        stack.push(...this.children(next.id).toReversed());
      }
    }

    return result;
  }

  /**
   * The IDs of `subtree(T)`, sorted by ID: the values of T's subtree CHECK.
   *
   * @param classId - A class ID.
   * @returns The sorted IDs.
   */
  subtreeIds(classId: DefinitionId): readonly DefinitionId[] {
    return this.subtree(classId)
      .map((definition) => definition.id)
      .toSorted(compareIds);
  }

  /**
   * @param classId - A class ID.
   * @returns The live fields the class itself adds, sorted by ID.
   */
  ownFields(classId: DefinitionId): readonly FieldDefinition[] {
    return this.#fieldsByClass.get(classId) ?? [];
  }

  /**
   * The live fields of a class and its ancestors, root's fields first.
   *
   * @param classId - A class ID.
   * @returns The fields.
   */
  fields(classId: DefinitionId): readonly FieldDefinition[] {
    return this.lineage(classId).flatMap((level) => this.ownFields(level.id));
  }

  /**
   * A live field of a class or its ancestors, by name.
   *
   * @param classId - A class ID.
   * @param name - The field name.
   * @returns The field, or undefined.
   */
  fieldByName(
    classId: DefinitionId,
    name: string
  ): FieldDefinition | undefined {
    return this.fields(classId).find((field) => field.name === name);
  }

  /**
   * Every live field in the hierarchy of a class (from its root down),
   * which is the scope of field-name uniqueness (Contracts 1.1).
   *
   * @param classId - Any class of the hierarchy.
   * @returns The fields.
   */
  hierarchyFields(classId: DefinitionId): readonly FieldDefinition[] {
    const root = this.root(classId);

    return root === undefined
      ? []
      : this.subtree(root.id).flatMap((level) => this.ownFields(level.id));
  }

  /**
   * @param classId - A class ID.
   * @returns The live overrides attached to the class itself.
   */
  ownOverrides(classId: DefinitionId): readonly OverrideDefinition[] {
    return this.#overridesByClass.get(classId) ?? [];
  }

  /**
   * @param classId - A class ID.
   * @returns The live indexes on the class's table.
   */
  indexes(classId: DefinitionId): readonly IndexDefinition[] {
    return this.#indexesByClass.get(classId) ?? [];
  }

  /**
   * @returns Every live grant.
   */
  grants(): readonly GrantDefinition[] {
    return this.all("grant").filter(isLive);
  }

  /**
   * @returns Every live access rule.
   */
  accessRules(): readonly AccessRuleDefinition[] {
    return this.all("accessRule").filter(isLive);
  }

  /**
   * @returns Every live subscription.
   */
  subscriptions(): readonly SubscriptionDefinition[] {
    return this.all("subscription").filter(isLive);
  }
}
