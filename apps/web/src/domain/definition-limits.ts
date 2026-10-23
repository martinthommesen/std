import { sameTypeApartFromAllowedRecords } from "@std/definitions/allowed-records";
import { isJsonObject } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Option } from "effect";

import type { MetaField } from "./metadata.ts";
/**
 * What the schema engine refuses on a definition record that metadata
 * cannot say per record (Contracts 1.4, 6.3; decision 0017 and 0020)
 * [judgment, decision 0020].
 *
 * Metadata states write limits per table and field (`write.update` is
 * `perRecord` where the engine allows an update of some records). For
 * `core.field` the engine allows less, by what the stored definition
 * holds, and the generic form must not offer a change the engine always
 * refuses:
 *
 * - `type`: only a reference's allowed-records condition may change
 *   (`sameTypeApartFromAllowedRecords`), so the type of a field that is
 *   not a reference is read-only, and a reference's type may be edited
 *   only in `allowedRecords` (the client says so before sending);
 * - `required` may only become true, so a required field's `required` is
 *   read-only;
 * - auto-numbering cannot be switched on or off, so `number_prefix` is
 *   read-only on a field without one.
 *
 * The server still decides (`DefinitionInvalid` with the engine's
 * message); these limits only keep the form from offering what it refuses.
 */
import type { RecordJson } from "./record.ts";

/** The table of field definitions. */
export const FIELD_TABLE = "core.field";

/** The message a reference's type edit beyond its condition gets. */
export const TYPE_CHANGE_TEXT =
  "Only a reference's allowedRecords condition can change; the kind, the target and the other settings are fixed. Add a new field and retire this one instead.";

const READ_ONLY = { create: "yes", update: "no" } as const;

const storedOf = (record: RecordJson, name: string): JsonValue =>
  record.values[name] ?? null;

const isReferenceType = (type: JsonValue): boolean =>
  isJsonObject(type) && type.kind === "reference";

/**
 * Whether the engine refuses every update of a field of this record.
 *
 * @param field - A field of `core.field`.
 * @param record - The stored field definition.
 * @returns True when the form must show it read-only.
 */
const isFixed = (field: MetaField, record: RecordJson): boolean => {
  if (field.name === "type") {
    return !isReferenceType(storedOf(record, "type"));
  }

  if (field.name === "required") {
    return storedOf(record, "required") === true;
  }

  return field.name === "number_prefix"
    ? storedOf(record, "number_prefix") === null
    : false;
};

/**
 * The fields of a definition table's form with the engine's per-record
 * limits applied: a field the engine never lets this record change is not
 * writable on update.
 *
 * @param table - The form's table.
 * @param fields - Its fields, as metadata describes them.
 * @param maybeRecord - The record edited, if any.
 * @returns The fields, limited.
 */
export const withRecordLimits = (
  table: string,
  fields: readonly MetaField[],
  maybeRecord: Option.Option<RecordJson>
): readonly MetaField[] =>
  Option.match(maybeRecord, {
    onNone: () => fields,
    onSome: (record) =>
      table === FIELD_TABLE
        ? fields.map((field) =>
            field.write.update !== "no" && isFixed(field, record)
              ? {
                  ...field,
                  write: { ...READ_ONLY, create: field.write.create },
                }
              : field
          )
        : fields,
  });

/**
 * The problems the engine would report for a definition record's body,
 * found before sending: a reference's type changed beyond its condition.
 *
 * @param table - The form's table.
 * @param fields - Its fields.
 * @param values - The body's values, by field name.
 * @param maybeRecord - The record edited, if any.
 * @returns Problems by field ID.
 */
export const definitionProblems = (
  table: string,
  fields: readonly MetaField[],
  values: Readonly<Record<string, JsonValue>>,
  maybeRecord: Option.Option<RecordJson>
): Readonly<Record<string, readonly string[]>> => {
  const typeField = fields.find((field) => field.name === "type");
  const newType = values.type;

  if (
    table !== FIELD_TABLE ||
    typeField === undefined ||
    newType === undefined ||
    Option.isNone(maybeRecord)
  ) {
    return {};
  }

  return sameTypeApartFromAllowedRecords(
    storedOf(maybeRecord.value, "type"),
    newType
  )
    ? {}
    : { [typeField.id]: [TYPE_CHANGE_TEXT] };
};
