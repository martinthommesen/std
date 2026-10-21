/**
 * Row visibility and the visible schema at an endpoint (Contracts 2.3, 3.4,
 * 3.5).
 *
 * At endpoint E the caller sees records of every class in subtree(E). Each
 * concrete class has a record decision; classes with equal decisions form a
 * **group** (so classes without their own rules share their parent's
 * predicate), and the SQL `WHERE` becomes
 * `(class_id IN group1 AND p1) OR (class_id IN group2 AND p2) ...`.
 *
 * A field of E or an ancestor is, at E, never if it is never on every class
 * whose records the caller can see, always if always on every such class,
 * and otherwise conditional, with its predicate selected per group by
 * `class_id`. The visible schema is every field that is not never, plus the
 * system fields. Write-only types (password, secret) stay in it: their
 * values are never returned, only `{"set": bool}` (Contracts 6.5).
 */
import type {
  AccessAction,
  FieldDefinition,
} from "@std/definitions/definition";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { decisionKey } from "./decision.ts";
import type { Decision } from "./decision.ts";
import { fieldDecision, recordDecision } from "./rules.ts";
import type { Caller, FieldAction } from "./rules.ts";

/** Classes sharing one decision that is not never. */
export interface ClassGroup {
  /** The concrete classes, sorted by ID. */
  readonly classIds: readonly DefinitionId[];
  /** Always or conditional. */
  readonly decision: Decision;
}

/** A decision per class, grouped; classes decided never are left out. */
export interface Grouped {
  readonly groups: readonly ClassGroup[];
}

/** How readable a field is at an endpoint (Contracts 3.4). */
export type Readability = "never" | "always" | "conditional";

/** A field of the visible schema. */
export interface VisibleField {
  readonly field: FieldDefinition;
  /** Always or conditional. */
  readonly readability: Exclude<Readability, "never">;
  /** Where it is readable: per class group, among row-visible classes. */
  readonly groups: readonly ClassGroup[];
}

/**
 * The system fields (Contracts 2.1, 3.2): they follow row visibility and
 * are never writable. `id`, `class` and `version` are envelope members of
 * record JSON; the audit fields are values.
 */
export const SYSTEM_FIELD_NAMES = [
  "id",
  "class",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
] as const;

/** A system field name. */
export type SystemFieldName = (typeof SYSTEM_FIELD_NAMES)[number];

/**
 * Whether a name is a system field.
 *
 * @param name - A field name.
 * @returns True for `id`, `class`, `version` and the audit fields.
 */
export const isSystemFieldName = (name: string): name is SystemFieldName =>
  SYSTEM_FIELD_NAMES.some((system) => system === name);

/** What a caller may see through one endpoint. */
export interface VisibleSchema {
  /** The endpoint's class. */
  readonly classId: DefinitionId;
  /** The concrete classes considered: subtree(E), or exactly one class. */
  readonly classIds: readonly DefinitionId[];
  /** Row visibility; no groups means no visible records. */
  readonly rows: Grouped;
  /** The fields that are not never, in the class's field order. */
  readonly fields: readonly VisibleField[];
  /** A visible field by name; undefined for never-readable and unknown ones. */
  readonly byName: (name: string) => VisibleField | undefined;
  /** A visible field by ID. */
  readonly byId: (fieldId: DefinitionId) => VisibleField | undefined;
}

/**
 * Groups classes by their decision, leaving out never.
 *
 * @param classIds - Concrete classes.
 * @param decide - The decision for one class.
 * @returns The groups, in the order their first class appears.
 */
export const groupClasses = (
  classIds: readonly DefinitionId[],
  decide: (classId: DefinitionId) => Decision
): Grouped => {
  const byKey = new Map<
    string,
    { classIds: DefinitionId[]; decision: Decision }
  >();

  for (const classId of classIds) {
    const decision = decide(classId);

    if (decision.kind !== "never") {
      const key = decisionKey(decision);
      const group = byKey.get(key);

      if (group === undefined) {
        byKey.set(key, { classIds: [classId], decision });
      } else {
        group.classIds.push(classId);
      }
    }
  }

  return {
    groups: [...byKey.values()].map((group) => ({
      classIds: group.classIds.toSorted(compareIds),
      decision: group.decision,
    })),
  };
};

/**
 * The readability of grouped decisions.
 *
 * @param grouped - Groups over the row-visible classes.
 * @param classCount - How many row-visible classes there are.
 * @returns Never, always or conditional.
 */
export const readabilityOf = (
  grouped: Grouped,
  classCount: number
): Readability => {
  const covered = grouped.groups.reduce(
    (count, group) => count + group.classIds.length,
    0
  );

  if (covered === 0) {
    return "never";
  }

  const allAlways = grouped.groups.every(
    (group) => group.decision.kind === "always"
  );

  return allAlways && covered === classCount ? "always" : "conditional";
};

/**
 * Record decisions of an action over the classes of an endpoint, grouped:
 * the row predicate for reads, the record check for writes.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - The action.
 * @param classIds - The concrete classes (usually subtree(E)).
 * @returns The groups.
 */
export const recordGroups = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: AccessAction,
  classIds: readonly DefinitionId[]
): Grouped =>
  groupClasses(classIds, (classId) =>
    recordDecision(snapshot, caller, action, classId)
  );

/**
 * Field decisions of an action over the classes of an endpoint, grouped.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - Read, create or update.
 * @param classIds - The concrete classes.
 * @param fieldId - A field every one of the classes has.
 * @returns The groups.
 */
export const fieldGroups = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: FieldAction,
  classIds: readonly DefinitionId[],
  fieldId: DefinitionId
): Grouped =>
  groupClasses(classIds, (classId) =>
    fieldDecision(snapshot, caller, action, classId, fieldId)
  );

/** Options of {@link visibleSchema}. */
export interface VisibleSchemaOptions {
  /**
   * Consider exactly this class instead of subtree(E): for a record whose
   * concrete class is known (get by ID, history).
   */
  readonly exact?: boolean;
}

/**
 * The visible schema of an endpoint for a caller.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param classId - The endpoint's class E.
 * @param options - `exact` for one concrete class.
 * @returns Row groups and the fields that are not never.
 */
export const visibleSchema = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId,
  options: VisibleSchemaOptions = {}
): VisibleSchema => {
  const classIds =
    options.exact === true ? [classId] : snapshot.subtreeIds(classId);

  const rows = recordGroups(snapshot, caller, "read", classIds);
  const visibleClasses = rows.groups.flatMap((group) => group.classIds);
  const fields: VisibleField[] = [];

  for (const field of snapshot.fields(classId)) {
    const grouped = fieldGroups(
      snapshot,
      caller,
      "read",
      visibleClasses,
      field.id
    );

    const readability = readabilityOf(grouped, visibleClasses.length);

    if (readability !== "never") {
      fields.push({ field, groups: grouped.groups, readability });
    }
  }

  const byName = new Map(fields.map((entry) => [entry.field.name, entry]));
  const byId = new Map(fields.map((entry) => [entry.field.id, entry]));

  return {
    byId: (fieldId) => byId.get(fieldId),
    byName: (name) => byName.get(name),
    classId,
    classIds,
    fields,
    rows,
  };
};
