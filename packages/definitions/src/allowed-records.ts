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
import { jsonbEquals } from "@std/values/jsonb";
import { getOrUndefined } from "effect/Option";
import { decodeUnknownOption } from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import type { Condition } from "./condition.ts";

const decodeCondition = decodeUnknownOption(ConditionSchema);

/** A field type, or a definition's `type` as JSON. */
type TypeJson = JsonValue | undefined;

const MUTABLE_TYPE_SETTINGS: ReadonlySet<string> = new Set([
  "allowedRecords",
  "textPolicy",
  "nonBlank",
]);

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
 * A field type's immutable settings, for comparing
 * the parts of a type that never change (Contracts 6.5). An explicit
 * `aggregate: false` is the absent default and is dropped too, so the
 * owner-reference setting compares by meaning (4.9: fixed at creation).
 *
 * @param type - A field type or its JSON.
 * @returns The JSON without mutable allowedRecords/textPolicy/nonBlank settings.
 */
export const fixedTypeSettings = (type: TypeJson): TypeJson =>
  type !== undefined && isJsonObject(type)
    ? Object.fromEntries(
        Object.entries(type).filter(
          ([key, value]) =>
            !MUTABLE_TYPE_SETTINGS.has(key) &&
            !(key === "aggregate" && value === false)
        )
      )
    : type;

/**
 * Whether two field types retain all fixed settings. The reference predicate
 * and text validation/preservation policies may change without rewriting rows.
 *
 * @param before - The stored type.
 * @param after - The new type.
 * @returns True when all fixed settings are equal.
 */
export const sameFixedType = (before: TypeJson, after: TypeJson): boolean => {
  const left = fixedTypeSettings(before);
  const right = fixedTypeSettings(after);

  return left === undefined || right === undefined
    ? left === right
    : jsonbEquals(left, right);
};
