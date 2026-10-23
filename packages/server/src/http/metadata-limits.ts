/**
 * What the generic record routes allow at all, whatever the access rules
 * say (guarantee 2A: metadata never shows a write the server always
 * refuses):
 *
 * - A platform table (Contracts 1.9) that is not a definition table
 *   (`core.change`, the journal, the config-layer tables) refuses every
 *   generic create, update and delete with `NotAllowed` (decision 0014):
 *   it is not creatable and no field is writable. The stored data class
 *   core.dead_delivery_action is appended only by its internal task writer
 *   (decision 0037).
 * - A definition table's generic writes become one-operation change sets
 *   (Contracts 1.4, `definition-writes.ts`). Columns no write may set
 *   (system, owner, protection, enforcement) are `no`; `state` is never
 *   set on create and on update only retires or reactivates a retirable
 *   kind; `name` is updated only for a renamable kind or one whose name
 *   `update` may change; any other column only when `update` may change
 *   its property (an override is replaced whole). Where the engine allows
 *   an update, protected and shipped definitions still accept less (1.8,
 *   8.2), so it is at most `perRecord`.
 * - Every other table: no limit.
 */
import type { WriteLimits, WriteStates } from "@std/access/table-metadata";
import { NO_WRITE_LIMITS } from "@std/access/table-metadata";
import type {
  DefinitionKind,
  FieldDefinition,
} from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { RENAMABLE, RETIRABLE, UPDATABLE } from "@std/definitions/operation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { TABLE_OF } from "../catalog/definition-tables.ts";
import { DEFINITION_KIND_OF_TABLE } from "./change-sets.ts";
import { READ_ONLY_COLUMNS } from "./definition-writes.ts";

const NEVER: WriteStates = { create: "no", update: "no" };

/**
 * The property a definition table's column holds.
 *
 * @param kind - The definition kind.
 * @param column - The column (the field's name).
 * @returns The property, or undefined for a column no write names.
 */
const propertyOf = (
  kind: DefinitionKind,
  column: string
): string | undefined => {
  const entry = TABLE_OF.get(kind);

  return [...(entry?.columns ?? []), ...(entry?.special ?? [])].find(
    (spec) => spec.column === column
  )?.property;
};

const updatable = (kind: DefinitionKind, property: string): boolean => {
  if (property === "name") {
    return RENAMABLE.has(kind) || UPDATABLE[kind].includes("name");
  }

  // An override is replaced whole by `setOverride` (`PATCH_OTHER_OPERATIONS`).
  return kind === "override" || UPDATABLE[kind].includes(property);
};

/**
 * The most a generic write of a definition table's column can be.
 *
 * @param kind - The table's definition kind.
 * @param column - The column.
 * @returns The limit.
 */
const definitionColumnLimit = (
  kind: DefinitionKind,
  column: string
): WriteStates => {
  if (READ_ONLY_COLUMNS.has(column)) {
    return NEVER;
  }

  if (column === "state") {
    return { create: "no", update: RETIRABLE.has(kind) ? "perRecord" : "no" };
  }

  const property = propertyOf(kind, column);

  if (property === undefined) {
    return NEVER;
  }

  return {
    create: "yes",
    update: updatable(kind, property) ? "perRecord" : "no",
  };
};

/**
 * The write limits of the generic record routes for one snapshot.
 *
 * @param snapshot - The configuration at the request's revision.
 * @returns The limits `tableMetadata` caps `creatable` and `write` with.
 */
export const genericWriteLimits = (snapshot: ConfigSnapshot): WriteLimits => {
  const kindOf = (classId: DefinitionId): DefinitionKind | undefined => {
    const name = snapshot.qualifiedNameOf(classId);

    return name === undefined ? undefined : DEFINITION_KIND_OF_TABLE.get(name);
  };

  const platform = (classId: DefinitionId): boolean =>
    snapshot.class(classId)?.storage === "platform";

  return {
    creatable: (classId) => !platform(classId) || kindOf(classId) !== undefined,
    field: (classId: DefinitionId, field: FieldDefinition) => {
      if (!platform(classId)) {
        return NO_WRITE_LIMITS.field(classId, field);
      }

      const kind = kindOf(classId);

      return kind === undefined
        ? NEVER
        : definitionColumnLimit(kind, field.name);
    },
  };
};
