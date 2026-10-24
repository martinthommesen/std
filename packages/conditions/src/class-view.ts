/**
 * What the condition engine needs to know about classes and fields. Callers
 * implement {@link ClassView}: `@std/definitions` over a config snapshot,
 * tests over fixtures. The engine never reads definitions any other way, so
 * a view decides which schema a condition is checked and compiled against
 * (a request's revision, a caller's visible schema).
 */
import type { ChoiceList } from "@std/values/choice";
import type { FieldType } from "@std/values/field-type";

/** One field as the condition engine sees it. */
export interface FieldInfo {
  /** The field's stable ID. */
  readonly id: string;
  /** The field's current name, used by the text syntax only. */
  readonly name: string;
  /** The class that declares the field (the record's class or an ancestor). */
  readonly classId: string;
  /**
   * The field's type with its settings. `caseSensitive` (text, long text)
   * and the reference target class (`targetClassId`) are read from here.
   */
  readonly type: FieldType;
  /** Whether the field is retired (Contracts 1.6). */
  readonly retired: boolean;
  /**
   * Choice fields: the field's active and retired keys, to refuse literals
   * that name no choice. Omitted: keys are checked for format only.
   */
  readonly choices?: ChoiceList;
}

/**
 * The classes and fields a condition may name.
 *
 * - `field(classId, fieldId)` returns a field of the class or one of its
 *   ancestors, and undefined for every other ID, child-only fields included
 *   (Contracts 2.3, 5.9: paths name fields of the declared target class and
 *   its ancestors only). Retired fields are returned with `retired: true`;
 *   purged fields are not returned.
 * - `canRead(classId, fieldId)`, when present, is the set of fields the
 *   profile may read: for the filter profile, the caller's visible schema on
 *   every hop (Contracts 3.4). The checker treats an unreadable field exactly
 *   like a missing one, so both give the same `unknownField` issue. Omit it
 *   for profiles that read as system (access, record and subscription rules)
 *   and for form rules, where unreadable fields count as empty at evaluation
 *   instead (`simplifyForCaller` in `@std/conditions/simplify`).
 * - `fieldByName(classId, name)` is used by the text syntax parser only.
 */
export interface ClassView {
  readonly field: (classId: string, fieldId: string) => FieldInfo | undefined;
  readonly canRead?: (classId: string, fieldId: string) => boolean;
  readonly fieldByName?: (
    classId: string,
    name: string
  ) => FieldInfo | undefined;
}

/**
 * Builds a view over a fixed list of fields, for tests and simple callers.
 *
 * @param classes - Each class with its parent (or null) and own fields.
 * @returns A view that resolves a class's own and inherited fields.
 */
export const staticClassView = (
  classes: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly fields: readonly FieldInfo[];
  }[]
): ClassView => {
  const byId = new Map(classes.map((entry) => [entry.id, entry]));

  const lookup = (
    classId: string,
    matches: (field: FieldInfo) => boolean
  ): FieldInfo | undefined => {
    let current = byId.get(classId);
    const seen = new Set<string>();

    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const found = current.fields.find(matches);

      if (found !== undefined) {
        return found;
      }

      current =
        current.parentId === null ? undefined : byId.get(current.parentId);
    }

    return undefined;
  };

  return {
    field: (classId, fieldId) =>
      lookup(classId, (field) => field.id === fieldId),
    fieldByName: (classId, name) =>
      lookup(classId, (field) => field.name === name),
  };
};
