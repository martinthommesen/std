/**
 * The fields a read can name: the definition fields of the visible schema
 * and the system fields (Contracts 3.4). System fields follow row
 * visibility, so they are always readable on a visible record; they get
 * fixed synthetic IDs so the condition engine can name them in filters
 * (`created_at > now - 7 days`, `created_by.name = "Alice"`,
 * `class = "acme.laptop"`).
 */
import type { SystemFieldName } from "@std/access/visible-schema";
import type { FieldInfo } from "@std/conditions/class-view";
import type { DefinitionId } from "@std/definitions/ids";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import type { FieldType } from "@std/values/field-type";

/** A field as the read compiler sees it. */
export interface ReadField {
  /** The field's stable ID, or a system field's synthetic ID. */
  readonly id: DefinitionId;
  readonly name: string;
  readonly type: FieldType;
  /** The class declaring it; for system fields, the class it was resolved on. */
  readonly classId: DefinitionId;
  /** Set for system fields. */
  readonly system?: SystemFieldName;
  /** Whether the field is retired. */
  readonly retired: boolean;
}

/** Synthetic IDs of the system fields. They are not definitions. */
export const SYSTEM_FIELD_IDS: Readonly<Record<SystemFieldName, DefinitionId>> =
  {
    class: "00000000-0000-4000-8000-5354440000c1",
    created_at: "00000000-0000-4000-8000-5354440000c3",
    created_by: "00000000-0000-4000-8000-5354440000c4",
    id: "00000000-0000-4000-8000-5354440000c0",
    updated_at: "00000000-0000-4000-8000-5354440000c5",
    updated_by: "00000000-0000-4000-8000-5354440000c6",
    version: "00000000-0000-4000-8000-5354440000c2",
  };

const SYSTEM_TYPES: Readonly<Record<SystemFieldName, FieldType>> = {
  class: { caseSensitive: true, kind: "text", maxLength: 4000 },
  created_at: { kind: "dateTime" },
  created_by: { kind: "reference", targetClassId: USER_CLASS_ID },
  id: { kind: "uuid" },
  updated_at: { kind: "dateTime" },
  updated_by: { kind: "reference", targetClassId: USER_CLASS_ID },
  version: { kind: "bigInteger" },
};

/** The system fields in their output order. */
export const SYSTEM_FIELDS: readonly SystemFieldName[] = [
  "id",
  "class",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
];

/** The system fields that are record values (the rest are envelope members). */
export const AUDIT_FIELDS: readonly SystemFieldName[] = [
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
];

/**
 * A system field resolved on a class.
 *
 * @param name - The system field.
 * @param classId - The class it is read on.
 * @returns The read field.
 */
export const systemField = (
  name: SystemFieldName,
  classId: DefinitionId
): ReadField => ({
  classId,
  id: SYSTEM_FIELD_IDS[name],
  name,
  retired: false,
  system: name,
  type: SYSTEM_TYPES[name],
});

/**
 * The condition engine's view of a read field.
 *
 * @param field - A read field.
 * @returns Its field info.
 */
export const fieldInfoOf = (field: ReadField): FieldInfo => ({
  classId: field.classId,
  id: field.id,
  name: field.name,
  retired: field.retired,
  type: field.type,
});
