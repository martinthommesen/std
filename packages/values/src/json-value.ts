/**
 * The JSON value type and its guards.
 */

/** A JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any JSON value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

/**
 * Whether a JSON value is an array.
 *
 * @param value - A JSON value.
 * @returns True for arrays.
 */
export const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

/**
 * Whether a JSON value is an object.
 *
 * @param value - A JSON value.
 * @returns True for objects (not arrays, not null).
 */
export const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a JSON value is a string.
 *
 * @param value - A JSON value.
 * @returns True for strings.
 */
export const isJsonString = (value: JsonValue): value is string =>
  typeof value === "string";

/**
 * Whether a JSON value is a number.
 *
 * @param value - A JSON value.
 * @returns True for numbers.
 */
export const isJsonNumber = (value: JsonValue): value is number =>
  typeof value === "number";

/**
 * Whether a JSON value is a boolean.
 *
 * @param value - A JSON value.
 * @returns True for `true` and `false`.
 */
export const isJsonBoolean = (value: JsonValue): value is boolean =>
  typeof value === "boolean";

/**
 * Whether a JavaScript value is made of JSON types only: null, booleans,
 * finite numbers, strings, arrays and plain objects. For values that did not
 * come from a JSON parser.
 *
 * @param input - Any JavaScript value.
 * @returns True when the value is a JSON value.
 */
export const isJsonValue = (input: unknown): input is JsonValue => {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string"
  ) {
    return true;
  }

  if (typeof input === "number") {
    return Number.isFinite(input);
  }

  if (typeof input !== "object") {
    return false;
  }

  if (Array.isArray(input)) {
    return input.every(isJsonValue);
  }

  const prototype: unknown = Object.getPrototypeOf(input);
  const plain = prototype === Object.prototype || prototype === null;

  return plain && Object.values(input).every(isJsonValue);
};
