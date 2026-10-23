/**
 * The record JSON encoder (Contracts 6.5, 6.6): from the text the database
 * returns (every value is selected `::text`, read under `TimeZone=UTC` and
 * `DateStyle=ISO`) to canonical JSON.
 *
 * ```json
 * { "id": "...", "class": "acme.laptop", "version": 7,
 *   "values": { "name": "L", "cost": "1200.00" },
 *   "labels": { "owner": "Bob" }, "withheld": ["docked_to"] }
 * ```
 *
 * - An absent key means "not delivered": unselected, or withheld by access
 *   rules (then the name is listed in `withheld`). `null` is a stored empty.
 * - `labels` appears only when requested, `withheld` only when non-empty.
 * - Password and secret arrive as the text of `col IS NOT NULL` and leave as
 *   `{"set": bool}`; their stored hash or envelope is never selected.
 *
 * Bodies are serialized with `stringifyJson`, so json values keep jsonb's
 * key order. Writes use the same encoder for the record they return.
 */
import { encodeOut } from "@std/values/codec";
import { getOrThrow } from "@std/values/field-error";
import type { FieldType } from "@std/values/field-type";
import type { JsonObject, JsonValue } from "@std/values/json-value";

import { parseStoredText } from "./stored-values.ts";

/**
 * The canonical JSON of a value read as text.
 *
 * @param type - The field's type.
 * @param text - The value's text, or null for a stored empty.
 * @returns Canonical JSON (`{"set": false}` for an empty password or secret).
 */
export const encodeTextValue = (
  type: FieldType,
  text: string | null
): JsonValue =>
  encodeOut(
    type,
    text === null ? null : getOrThrow(parseStoredText(type.kind, text))
  );

/** The parts of one record's JSON. */
export interface RecordParts {
  readonly id: string;
  /** The concrete class's qualified name. */
  readonly className: string;
  readonly version: number;
  /** Delivered values by field name or dotted path. */
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Labels by reference field name; null when not requested. */
  readonly labels: Readonly<Record<string, string>> | null;
  /** Selected fields withheld by access rules on this record. */
  readonly withheld: readonly string[];
}

/**
 * One record's JSON (Contracts 6.6).
 *
 * @param parts - Envelope, values, labels and withheld names.
 * @returns The JSON object, keys in a fixed order.
 */
export const recordJson = (parts: RecordParts): JsonObject => {
  const envelope = {
    class: parts.className,
    id: parts.id,
    values: parts.values,
    version: parts.version,
  } satisfies JsonObject;

  const labelled =
    parts.labels === null ? envelope : { ...envelope, labels: parts.labels };

  return parts.withheld.length === 0
    ? labelled
    : { ...labelled, withheld: parts.withheld };
};
