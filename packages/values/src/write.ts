/**
 * Absent versus null in write payloads (Contracts 6.7).
 *
 * | Payload    | Create                    | Update            |
 * | ---------- | ------------------------- | ----------------- |
 * | key absent | default, otherwise null   | unchanged         |
 * | `null`     | null, default not applied | cleared           |
 * | value      | converted per 6.5         | converted per 6.5 |
 *
 * Booleans are never null: absent on create stores false (or the default),
 * and an explicit null is `InvalidValue`.
 */
import { decodeIn } from "./codec.ts";
import { ok } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";
import type { FieldKind, FieldType, FieldTypeOf } from "./field-type.ts";
import type { DecodedInput } from "./field-value.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";

/** One payload key: absent, or present with its JSON value (which may be null). */
export type PayloadEntry =
  | { readonly present: false }
  | { readonly present: true; readonly json: JsonValue };

/** Where a planned value came from. */
export type WriteSource = "payload" | "default" | "empty";

/** What a write does to one field. */
export type FieldWrite<K extends FieldKind = FieldKind> =
  | { readonly action: "keep" }
  | {
      readonly action: "set";
      readonly value: DecodedInput<K>;
      readonly source: WriteSource;
    };

/**
 * Reads one key of a payload object, telling absent from null.
 *
 * @param payload - The `values` object of a write body.
 * @param key - The field name.
 * @returns The entry; only own properties count.
 */
export const payloadEntry = (payload: JsonObject, key: string): PayloadEntry =>
  Object.hasOwn(payload, key)
    ? { json: payload[key] ?? null, present: true }
    : { present: false };

/**
 * Plans a field on create.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @param defaultValue - The field's static or computed default, if any.
 * @returns A `set` of the converted value, the default, or the empty value
 *   (false for boolean, null otherwise); or an `InvalidValue`.
 */
export function planCreate<K extends FieldKind>(
  type: FieldTypeOf<K>,
  entry: PayloadEntry,
  defaultValue?: DecodedInput<K>
): Decoded<FieldWrite<K>>;
/**
 * Plans a field on create.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @param defaultValue - The field's default, if any.
 * @returns The planned write, or an `InvalidValue`.
 */
export function planCreate(
  type: FieldType,
  entry: PayloadEntry,
  defaultValue?: DecodedInput
): Decoded<FieldWrite>;
/**
 * Plans a field on create.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @param defaultValue - The field's default, if any.
 * @returns The planned write, or an `InvalidValue`.
 */
export function planCreate(
  type: FieldType,
  entry: PayloadEntry,
  defaultValue?: DecodedInput
): Decoded<FieldWrite> {
  if (entry.present) {
    const decoded = decodeIn(type, entry.json);

    return decoded.ok
      ? ok({ action: "set", source: "payload", value: decoded.value })
      : decoded;
  }

  if (defaultValue !== undefined) {
    return ok({ action: "set", source: "default", value: defaultValue });
  }

  return ok({
    action: "set",
    source: "empty",
    value: type.kind === "boolean" ? false : null,
  });
}

/**
 * Plans a field on update.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @returns `keep` for an absent key, otherwise a `set` of the converted value
 *   (null clears); or an `InvalidValue`.
 */
export function planUpdate<K extends FieldKind>(
  type: FieldTypeOf<K>,
  entry: PayloadEntry
): Decoded<FieldWrite<K>>;
/**
 * Plans a field on update.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @returns The planned write, or an `InvalidValue`.
 */
export function planUpdate(
  type: FieldType,
  entry: PayloadEntry
): Decoded<FieldWrite>;
/**
 * Plans a field on update.
 *
 * @param type - The field type with its settings.
 * @param entry - The payload entry.
 * @returns The planned write, or an `InvalidValue`.
 */
export function planUpdate(
  type: FieldType,
  entry: PayloadEntry
): Decoded<FieldWrite> {
  if (!entry.present) {
    return ok({ action: "keep" });
  }

  const decoded = decodeIn(type, entry.json);

  return decoded.ok
    ? ok({ action: "set", source: "payload", value: decoded.value })
    : decoded;
}
