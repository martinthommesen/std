/**
 * A reference field's allowed-records condition (decision 0020; Contracts
 * 6.5): the `allowedRecords` setting of a reference type, a condition AST
 * over the target class (field IDs) that every newly written target must
 * satisfy, and that the picker ANDs to its list. It is checked under the
 * `filter` profile when it is stored (the field is created or the setting
 * changes), may change after the field exists (unlike the target), and
 * adds `condition_reads` edges like stored rule conditions.
 */
import type { FieldType } from "@std/values/field-type";
import { isJsonObject } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { getOrUndefined } from "effect/Option";
import { decodeUnknownOption } from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import type { Condition } from "./condition.ts";

const decodeCondition = decodeUnknownOption(ConditionSchema);

/** A field type, or a definition's `type` as JSON. */
type TypeJson = JsonValue | undefined;

/**
 * The allowed-records condition of a field type.
 *
 * @param type - A field type.
 * @returns The condition; null when the type has none (not a reference,
 *   or the setting is absent or null); undefined when the setting is not a
 *   condition AST, which validation refuses and the server compiles to
 *   false (fails closed).
 */
export const allowedRecordsOf = (
  type: FieldType
): Condition | null | undefined => {
  if (
    type.kind !== "reference" ||
    type.allowedRecords === undefined ||
    type.allowedRecords === null
  ) {
    return null;
  }

  return getOrUndefined(decodeCondition(type.allowedRecords));
};

/**
 * A field type's JSON without its allowed-records setting, for comparing
 * the parts of a type that never change (Contracts 6.5).
 *
 * @param type - A field type or its JSON.
 * @returns The JSON without `allowedRecords`.
 */
export const withoutAllowedRecords = (type: TypeJson): TypeJson =>
  type !== undefined && isJsonObject(type)
    ? Object.fromEntries(
        Object.entries(type).filter(([key]) => key !== "allowedRecords")
      )
    : type;

/**
 * Whether two field types differ in their allowed-records setting only
 * (or not at all), which is the one change a field's type may take.
 *
 * @param before - The stored type.
 * @param after - The new type.
 * @returns True when everything but `allowedRecords` is equal.
 */
export const sameTypeApartFromAllowedRecords = (
  before: TypeJson,
  after: TypeJson
): boolean =>
  JSON.stringify(withoutAllowedRecords(before)) ===
  JSON.stringify(withoutAllowedRecords(after));
