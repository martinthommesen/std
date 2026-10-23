/**
 * Converts generated canonical JSON rows into the images the evaluators read.
 */
import { decodeIn } from "@std/values/codec";
import type { StoredOrPlaintext } from "@std/values/compare";
import { getOrThrow } from "@std/values/field-error";
import type { JsonValue } from "@std/values/json-value";
import { secretState } from "@std/values/write-only";

import type { ImageSource, RecordImage } from "../../src/evaluate-core.ts";
import type { AssetRow, JsonImage, PersonRow } from "./generate.ts";
import { MASKED_FIELDS } from "./generate.ts";
import { ASSET_LIST, fixtureField, PERSON_LIST } from "./schema.ts";

/** An all-empty asset image. */
export const EMPTY_ASSET: RecordImage = Object.fromEntries(
  ASSET_LIST.map((field) => [field.id, null])
);

/** An all-empty person image. */
export const EMPTY_PERSON: RecordImage = Object.fromEntries(
  PERSON_LIST.map((field) => [field.id, null])
);

/**
 * Masks selected fields as empty in a complete image.
 *
 * @param image - The stored image.
 * @param ids - The hidden field IDs.
 * @returns The masked image.
 */
export const maskImage = (
  image: RecordImage,
  ids: ReadonlySet<string>
): RecordImage =>
  Object.fromEntries(
    Object.entries(image).map(([id, value]) => [id, ids.has(id) ? null : value])
  );

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

  return getOrThrow(decodeIn(field.type, json));
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
