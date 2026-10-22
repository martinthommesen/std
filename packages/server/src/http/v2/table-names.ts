/**
 * Table names in `/api/v2` (Contracts 10.1; TMF630 v5.0.0 Part 1 §2.5
 * p.22; Martin, 2026-10-22): a table's collection is its qualified name in
 * lowerCamelCase (`helpdesk.incident` is `/api/v2/helpdeskIncident`) and its
 * type name the same in UpperCamelCase (`@type` `HelpdeskIncident`).
 *
 * The inverse is a lookup over the snapshot's live tables, never a parse of
 * the name; definition validation refuses two tables with one v2 name, and a
 * table with a fixed resource's name (`apiNameClash`), so the lookup is
 * unambiguous. A table renamed after the request was built is simply not
 * found under its old name (`UnknownTable`), as in v1.
 */
import { isLive } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { apiTableNameOf, apiTypeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

/** A table's v2 names. */
interface TableNames {
  readonly collection: string;
  readonly type: string;
}

/** The v2 names of a snapshot's tables, both ways. */
interface NameIndex {
  readonly byClass: ReadonlyMap<DefinitionId, TableNames>;
  readonly byCollection: ReadonlyMap<string, DefinitionId>;
  readonly byType: ReadonlyMap<string, DefinitionId>;
}

const indexes = new WeakMap<ConfigSnapshot, NameIndex>();

const indexOf = (snapshot: ConfigSnapshot): NameIndex => {
  const existing = indexes.get(snapshot);

  if (existing !== undefined) {
    return existing;
  }

  const byClass = new Map<DefinitionId, TableNames>();
  const byCollection = new Map<string, DefinitionId>();
  const byType = new Map<string, DefinitionId>();

  for (const table of snapshot.all("class").filter(isLive)) {
    const namespace = snapshot.get(table.namespaceId);

    if (namespace?.kind === "namespace") {
      const names = {
        collection: apiTableNameOf(namespace.name, table.name),
        type: apiTypeNameOf(namespace.name, table.name),
      };

      byClass.set(table.id, names);
      byCollection.set(names.collection, table.id);
      byType.set(names.type, table.id);
    }
  }

  const index = { byClass, byCollection, byType };
  indexes.set(snapshot, index);

  return index;
};

/**
 * A table's v2 collection name (`helpdeskIncident`).
 *
 * @param snapshot - The configuration.
 * @param classId - The table.
 * @returns The name; the empty string for a table that is not live.
 */
export const collectionNameOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): string => indexOf(snapshot).byClass.get(classId)?.collection ?? "";

/**
 * A table's v2 type name (`HelpdeskIncident`).
 *
 * @param snapshot - The configuration.
 * @param classId - The table.
 * @returns The name; the empty string for a table that is not live.
 */
export const typeNameOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): string => indexOf(snapshot).byClass.get(classId)?.type ?? "";

/**
 * The qualified name of the table with a v2 collection name, if any.
 *
 * @param snapshot - The configuration.
 * @param collection - The path segment.
 * @returns The qualified name (`helpdesk.incident`), or undefined.
 */
export const tableOfCollection = (
  snapshot: ConfigSnapshot,
  collection: string
): string | undefined => {
  const classId = indexOf(snapshot).byCollection.get(collection);

  return classId === undefined ? undefined : snapshot.qualifiedNameOf(classId);
};

/**
 * The table with a v2 type name, if any.
 *
 * @param snapshot - The configuration.
 * @param type - The `@type` value.
 * @returns The class ID, or undefined.
 */
export const classOfType = (
  snapshot: ConfigSnapshot,
  type: string
): DefinitionId | undefined => indexOf(snapshot).byType.get(type);
