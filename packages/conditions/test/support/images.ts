/**
 * Converts generated canonical JSON rows into the images the evaluators read.
 */
import { decodeIn } from "@std/values/codec";
import type { StoredOrPlaintext } from "@std/values/compare";
import type { JsonValue } from "@std/values/json-value";
import { secretState } from "@std/values/write-only";

import type { ImageSource, RecordImage } from "../../src/evaluate-core.ts";
import type { AssetRow, JsonImage, PersonRow } from "./generate.ts";
import { MASKED_FIELDS } from "./generate.ts";
import { fixtureField } from "./schema.ts";

/**
 * The stored value of a canonical JSON value.
 *
 * @param fieldId - The field.
 * @param json - Its canonical JSON.
 * @returns The value the evaluators compare.
 */
export const storedValue = (
  fieldId: string,
  json: JsonValue
): StoredOrPlaintext => {
  const field = fixtureField(fieldId);

  if (json === null) {
    return null;
  }

  if (field.type.kind === "password" || field.type.kind === "secret") {
    return secretState(true);
  }

  const decoded = decodeIn(field.type, json);

  if (!decoded.ok) {
    throw decoded.error;
  }

  return decoded.value;
};

/**
 * Converts a JSON image.
 *
 * @param image - Canonical JSON by field ID.
 * @param masked - Field IDs that read as empty.
 * @returns The record image.
 */
export const toImage = (
  image: JsonImage,
  masked: ReadonlySet<string> = new Set()
): RecordImage =>
  Object.fromEntries(
    Object.entries(image).map(([id, json]) => [
      id,
      masked.has(id) ? null : storedValue(id, json),
    ])
  );

/**
 * The evaluator input for a generated row: masks applied, hidden targets
 * null, previous image null on create.
 *
 * @param row - The row.
 * @param people - The reference targets.
 * @returns The image source.
 */
export const sourceFor = (
  row: AssetRow,
  people: readonly PersonRow[]
): ImageSource => ({
  previous: row.previous === null ? null : toImage(row.previous),
  record: toImage(row.values, row.readable ? new Set() : MASKED_FIELDS),
  targets: new Map(
    people.map((person) => [
      person.id,
      person.visible ? toImage(person.values) : null,
    ])
  ),
});
