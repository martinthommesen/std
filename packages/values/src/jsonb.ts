/**
 * Postgres `jsonb` semantics in TypeScript (Contracts 6.5): object key order
 * and equality, so both engines agree on canonical output and on `changed`.
 *
 * jsonb orders object keys by their UTF-8 byte length, then bytewise, and
 * compares numbers by numeric value. Values reaching these functions passed
 * the json rules (no duplicate keys, numbers exact as doubles), so JS number
 * equality is numeric equality.
 */
import { isJsonArray, isJsonObject } from "./json-value.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";

const ONE_BYTE_LIMIT = 0x80;
const TWO_BYTE_LIMIT = 0x8_00;
const THREE_BYTE_LIMIT = 0x1_00_00;

/**
 * The UTF-8 byte length of a well-formed string.
 *
 * @param text - Well-formed text.
 * @returns Its length in UTF-8 bytes.
 */
export const utf8Length = (text: string): number => {
  let bytes = 0;
  let index = 0;

  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0;

    if (codePoint < ONE_BYTE_LIMIT) {
      bytes += 1;
    } else if (codePoint < TWO_BYTE_LIMIT) {
      bytes += 2;
    } else if (codePoint < THREE_BYTE_LIMIT) {
      bytes += 3;
    } else {
      bytes += 4;
      index += 1;
    }

    index += 1;
  }

  return bytes;
};

/**
 * Orders strings by code point, which is UTF-8 byte order (UTF-16 code unit
 * order differs for astral characters).
 *
 * @param left - Well-formed text.
 * @param right - Well-formed text.
 * @returns Negative, zero or positive.
 */
export const compareCodePoints = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    // At the first differing unit, codePointAt yields whole code points
    // unless both sides share a high surrogate, where the low ones decide.
    const difference =
      (left.codePointAt(index) ?? 0) - (right.codePointAt(index) ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
};

/**
 * jsonb's object key order: shorter UTF-8 byte length first, then bytewise.
 *
 * @param left - A key.
 * @param right - A key.
 * @returns Negative, zero or positive.
 */
export const compareJsonbKeys = (left: string, right: string): number =>
  utf8Length(left) - utf8Length(right) || compareCodePoints(left, right);

/**
 * The keys of an object in jsonb order.
 *
 * @param object - A JSON object.
 * @returns Its own enumerable keys, sorted as jsonb stores them.
 */
export const jsonbKeys = (object: JsonObject): string[] =>
  Object.keys(object).toSorted(compareJsonbKeys);

type Equality = (left: JsonValue, right: JsonValue) => boolean;

const arraysEqual = (
  left: readonly JsonValue[],
  right: readonly JsonValue[],
  equals: Equality
): boolean =>
  left.length === right.length &&
  left.every((item, index) => equals(item, right[index] ?? null));

const objectsEqual = (
  left: JsonObject,
  right: JsonObject,
  equals: Equality
): boolean => {
  const keys = Object.keys(left);

  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equals(left[key] ?? null, right[key] ?? null)
    )
  );
};

/**
 * jsonb equality: key order is irrelevant, numbers compare by value, strings
 * by code points.
 *
 * @param left - A JSON value.
 * @param right - A JSON value.
 * @returns True when Postgres `left::jsonb = right::jsonb` would be true.
 */
export const jsonbEquals: Equality = (left, right) => {
  if (isJsonArray(left) || isJsonArray(right)) {
    return (
      isJsonArray(left) &&
      isJsonArray(right) &&
      arraysEqual(left, right, jsonbEquals)
    );
  }

  if (isJsonObject(left) || isJsonObject(right)) {
    return (
      isJsonObject(left) &&
      isJsonObject(right) &&
      objectsEqual(left, right, jsonbEquals)
    );
  }

  return left === right;
};
