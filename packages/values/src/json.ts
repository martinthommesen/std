/**
 * Strict JSON (Contracts 6.5, json type).
 *
 * `JSON.parse` silently keeps the last of duplicate keys and rounds numbers
 * that a double cannot hold, while `jsonb` keeps the digits, so both engines
 * would see different values. {@link parseJson} refuses both. It also refuses
 * what `jsonb` cannot store (`\u0000`, lone surrogates), integers beyond
 * ±(2^53 - 1), and nesting deeper than {@link JSON_MAX_DEPTH}.
 *
 * Request bodies that carry json field values must be parsed with
 * {@link parseJson}, and json output must be written with
 * {@link stringifyJson}, which puts object keys in jsonb's order (JS objects
 * cannot hold that order for integer-like keys).
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded, Refused } from "./field-error.ts";
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "./json-value.ts";
import type { JsonObject, JsonValue } from "./json-value.ts";
import { jsonbKeys, utf8Length } from "./jsonb.ts";

/** The largest json value, in UTF-8 bytes of its canonical text (1 MiB). */
export const JSON_MAX_BYTES = 1_048_576;

/** The deepest nesting of arrays and objects accepted. */
export const JSON_MAX_DEPTH = 1000;

const LEADING_ZEROS = /^0+/u;
const HEX_DIGITS = /^[\dA-Fa-f]{4}$/u;
const HEX = 16;
const UNICODE_ESCAPE_LENGTH = 4;
const FIRST_NON_CONTROL = 0x20;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["/", "/"],
  ["\\", "\\"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

class JsonRefusalError extends Error {
  readonly refusal: Refused;

  constructor(refusal: Refused) {
    super(refusal.error.message);
    this.name = "JsonRefusalError";
    this.refusal = refusal;
  }
}

const fail = (refusal: Refused): never => {
  throw new JsonRefusalError(refusal);
};

const syntaxError = (): never =>
  fail(refuse("invalidJson", "The JSON text is malformed."));

interface Cursor {
  readonly text: string;
  index: number;
}

/** A number literal split into sign, significant digits and exponent. */
interface ExactDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

interface NumberParts {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
  readonly exponent: string;
}

const isDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= "0" && character <= "9";

const scanDigits = (text: string, start: number): number => {
  let end = start;

  while (isDigit(text[end])) {
    end += 1;
  }

  return end;
};

// Scans -?(0|[1-9]d*)(.d+)?([eE][+-]?d+)? at start.
const scanNumber = (
  text: string,
  start: number
): { end: number; parts: NumberParts } | undefined => {
  const negative = text[start] === "-";
  const integerStart = negative ? start + 1 : start;
  const integerEnd = scanDigits(text, integerStart);
  const integer = text.slice(integerStart, integerEnd);

  if (integer === "" || (integer.length > 1 && integer.startsWith("0"))) {
    return undefined;
  }

  let end = integerEnd;
  let fraction = "";

  if (text[end] === ".") {
    const fractionEnd = scanDigits(text, end + 1);
    fraction = text.slice(end + 1, fractionEnd);

    if (fraction === "") {
      return undefined;
    }

    end = fractionEnd;
  }

  let exponent = "";

  if (text[end] === "e" || text[end] === "E") {
    const signed = text[end + 1] === "+" || text[end + 1] === "-";
    const digitsStart = signed ? end + 2 : end + 1;
    const exponentEnd = scanDigits(text, digitsStart);

    if (exponentEnd === digitsStart) {
      return undefined;
    }

    exponent = text.slice(end + 1, exponentEnd);
    end = exponentEnd;
  }

  return { end, parts: { exponent, fraction, integer, negative } };
};

const toExactDecimal = (parts: NumberParts): ExactDecimal => {
  const significant = `${parts.integer}${parts.fraction}`.replace(
    LEADING_ZEROS,
    ""
  );

  let digitsEnd = significant.length;

  while (digitsEnd > 0 && significant[digitsEnd - 1] === "0") {
    digitsEnd -= 1;
  }

  const digits = significant.slice(0, digitsEnd);

  if (digits === "") {
    return { digits, exponent: 0, negative: false };
  }

  return {
    digits,
    exponent:
      Number(parts.exponent || "0") -
      parts.fraction.length +
      (significant.length - digits.length),
    negative: parts.negative,
  };
};

const sameExactDecimal = (left: ExactDecimal, right: ExactDecimal): boolean =>
  left.negative === right.negative &&
  left.digits === right.digits &&
  left.exponent === right.exponent;

/**
 * Checks a JSON number literal: it must denote exactly the double it parses
 * to (so jsonb and JavaScript hold the same value), and an integer within
 * ±(2^53 - 1).
 *
 * @param literal - A JSON number token such as `0.1` or `1e2`.
 * @returns The number (`-0` becomes `0`), or `invalidJson`, `inexactNumber`
 *   or `unsafeInteger`.
 */
export const checkNumberLiteral = (literal: string): Decoded<number> => {
  const written = scanNumber(literal, 0);

  if (written === undefined || written.end !== literal.length) {
    return refuse("invalidJson", "Not a JSON number.");
  }

  const value = Number(literal);

  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return refuse(
      "unsafeInteger",
      "JSON integers must be within ±(2^53 - 1); send larger values as strings."
    );
  }

  const roundTrip = scanNumber(String(value), 0);

  const exact =
    Number.isFinite(value) &&
    roundTrip !== undefined &&
    sameExactDecimal(
      toExactDecimal(written.parts),
      toExactDecimal(roundTrip.parts)
    );

  if (!exact) {
    return refuse(
      "inexactNumber",
      "JSON numbers must be exactly representable as a double; send such values as strings."
    );
  }

  return ok(value === 0 ? 0 : value);
};

const checkString = (text: string): string => {
  if (!text.isWellFormed()) {
    return fail(
      refuse("notWellFormed", "JSON strings must be well-formed Unicode.")
    );
  }

  if (text.includes("\0")) {
    return fail(refuse("nulCharacter", "JSON strings cannot contain U+0000."));
  }

  return text;
};

const isWhitespace = (character: string | undefined): boolean =>
  character === " " ||
  character === "\t" ||
  character === "\n" ||
  character === "\r";

const skipWhitespace = (cursor: Cursor): void => {
  while (isWhitespace(cursor.text[cursor.index])) {
    cursor.index += 1;
  }
};

const readEscape = (cursor: Cursor): string => {
  const marker = cursor.text[cursor.index + 1] ?? "";
  const simple = SIMPLE_ESCAPES.get(marker);

  if (simple !== undefined) {
    cursor.index += 2;

    return simple;
  }

  const hex = cursor.text.slice(
    cursor.index + 2,
    cursor.index + 2 + UNICODE_ESCAPE_LENGTH
  );

  if (marker !== "u" || !HEX_DIGITS.test(hex)) {
    return syntaxError();
  }

  cursor.index += 2 + UNICODE_ESCAPE_LENGTH;

  return String.fromCodePoint(Number.parseInt(hex, HEX));
};

const readString = (cursor: Cursor): string => {
  const { text } = cursor;
  let result = "";

  cursor.index += 1;
  let start = cursor.index;

  while (cursor.index < text.length) {
    const unit = text.codePointAt(cursor.index) ?? 0;

    if (unit === QUOTE) {
      result += text.slice(start, cursor.index);
      cursor.index += 1;

      return checkString(result);
    }

    if (unit === BACKSLASH) {
      result += text.slice(start, cursor.index) + readEscape(cursor);
      start = cursor.index;
    } else if (unit < FIRST_NON_CONTROL) {
      return syntaxError();
    } else {
      cursor.index += 1;
    }
  }

  return syntaxError();
};

const readNumber = (cursor: Cursor): number => {
  const scanned = scanNumber(cursor.text, cursor.index);

  if (scanned === undefined) {
    return syntaxError();
  }

  const checked = checkNumberLiteral(
    cursor.text.slice(cursor.index, scanned.end)
  );

  cursor.index = scanned.end;

  return checked.ok ? checked.value : fail(checked);
};

const readLiteral = <A extends JsonValue>(
  cursor: Cursor,
  word: string,
  value: A
): A => {
  if (!cursor.text.startsWith(word, cursor.index)) {
    return syntaxError();
  }

  cursor.index += word.length;

  return value;
};

const tooDeep = (): never =>
  fail(
    refuse("tooDeep", `JSON values nest at most ${JSON_MAX_DEPTH} levels deep.`)
  );

const setProperty = (
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue
): void => {
  // defineProperty keeps a "__proto__" key an ordinary own property.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const consume = (cursor: Cursor, character: string): void => {
  skipWhitespace(cursor);

  if (cursor.text[cursor.index] !== character) {
    syntaxError();
  }

  cursor.index += 1;
};

// Reads "," or the closing bracket; true at the end.
const readSeparator = (cursor: Cursor, closing: string): boolean => {
  skipWhitespace(cursor);
  const next = cursor.text[cursor.index];
  cursor.index += 1;

  if (next === closing) {
    return true;
  }

  return next === "," ? false : syntaxError();
};

// Consumes an opening bracket; true when the container is empty.
const openContainer = (cursor: Cursor, closing: string): boolean => {
  cursor.index += 1;
  skipWhitespace(cursor);

  if (cursor.text[cursor.index] === closing) {
    cursor.index += 1;

    return true;
  }

  return false;
};

type ValueReader = (cursor: Cursor, depth: number) => JsonValue;

const readArray = (
  cursor: Cursor,
  depth: number,
  readItem: ValueReader
): JsonValue[] => {
  const items: JsonValue[] = [];
  let done = openContainer(cursor, "]");

  while (!done) {
    items.push(readItem(cursor, depth + 1));
    done = readSeparator(cursor, "]");
  }

  return items;
};

const readObject = (
  cursor: Cursor,
  depth: number,
  readItem: ValueReader
): JsonObject => {
  const result: Record<string, JsonValue> = {};
  let done = openContainer(cursor, "}");

  while (!done) {
    skipWhitespace(cursor);

    if (cursor.text[cursor.index] !== '"') {
      syntaxError();
    }

    const key = readString(cursor);

    if (Object.hasOwn(result, key)) {
      fail(refuse("duplicateKey", "JSON objects cannot repeat a key."));
    }

    consume(cursor, ":");
    setProperty(result, key, readItem(cursor, depth + 1));
    done = readSeparator(cursor, "}");
  }

  return result;
};

const readValue: ValueReader = (cursor, depth) => {
  skipWhitespace(cursor);

  switch (cursor.text[cursor.index]) {
    case "{": {
      return depth >= JSON_MAX_DEPTH
        ? tooDeep()
        : readObject(cursor, depth, readValue);
    }

    case "[": {
      return depth >= JSON_MAX_DEPTH
        ? tooDeep()
        : readArray(cursor, depth, readValue);
    }

    case '"': {
      return readString(cursor);
    }

    case "t": {
      return readLiteral(cursor, "true", true);
    }

    case "f": {
      return readLiteral(cursor, "false", false);
    }

    case "n": {
      return readLiteral(cursor, "null", null);
    }

    case undefined: {
      return syntaxError();
    }

    default: {
      return readNumber(cursor);
    }
  }
};

const catchRefusal = <A>(run: () => Decoded<A>): Decoded<A> => {
  try {
    return run();
  } catch (error) {
    if (error instanceof JsonRefusalError) {
      return error.refusal;
    }

    throw error;
  }
};

/**
 * Parses JSON text under STD's json rules.
 *
 * @param text - JSON text (RFC 8259).
 * @returns The value, or `invalidJson`, `duplicateKey`, `inexactNumber`,
 *   `unsafeInteger`, `notWellFormed`, `nulCharacter` or `tooDeep`.
 */
export const parseJson = (text: string): Decoded<JsonValue> =>
  catchRefusal(() => {
    const cursor: Cursor = { index: 0, text };
    const value = readValue(cursor, 0);
    skipWhitespace(cursor);

    return cursor.index === text.length ? ok(value) : syntaxError();
  });

const checkNumber = (input: number): number => {
  if (!Number.isFinite(input)) {
    return fail(refuse("wrongJsonType", "JSON numbers must be finite."));
  }

  if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
    return fail(
      refuse("unsafeInteger", "JSON integers must be within ±(2^53 - 1).")
    );
  }

  return input === 0 ? 0 : input;
};

const canonicalValue = (input: JsonValue, depth: number): JsonValue => {
  if (isJsonString(input)) {
    return checkString(input);
  }

  if (isJsonNumber(input)) {
    return checkNumber(input);
  }

  if (!isJsonArray(input) && !isJsonObject(input)) {
    return input;
  }

  if (depth >= JSON_MAX_DEPTH) {
    return tooDeep();
  }

  if (isJsonArray(input)) {
    return input.map((item) => canonicalValue(item, depth + 1));
  }

  const result: Record<string, JsonValue> = {};

  for (const key of jsonbKeys(input)) {
    setProperty(
      result,
      checkString(key),
      canonicalValue(input[key] ?? null, depth + 1)
    );
  }

  return result;
};

const stringifyInto = (value: JsonValue, parts: string[]): void => {
  if (isJsonArray(value)) {
    parts.push("[");

    for (const [index, item] of value.entries()) {
      parts.push(index === 0 ? "" : ",");
      stringifyInto(item, parts);
    }

    parts.push("]");

    return;
  }

  if (isJsonObject(value)) {
    parts.push("{");

    for (const [index, key] of jsonbKeys(value).entries()) {
      parts.push(index === 0 ? "" : ",", JSON.stringify(key), ":");
      stringifyInto(value[key] ?? null, parts);
    }

    parts.push("}");

    return;
  }

  parts.push(JSON.stringify(value));
};

/**
 * Writes JSON text with object keys in jsonb's order.
 *
 * @param value - A JSON value.
 * @returns Compact canonical JSON text.
 */
export const stringifyJson = (value: JsonValue): string => {
  const parts: string[] = [];
  stringifyInto(value, parts);

  return parts.join("");
};

/**
 * Checks a value against the json rules and returns its canonical copy:
 * finite numbers, integers within ±(2^53 - 1), well-formed strings without
 * U+0000, nesting within {@link JSON_MAX_DEPTH}, at most
 * {@link JSON_MAX_BYTES}. Literal-level rules (duplicate keys, inexact
 * digits) need the text; see {@link parseJson}.
 *
 * @param input - A JSON value.
 * @returns The canonical copy (keys inserted in jsonb order, `-0` as `0`), or
 *   a refusal.
 */
export const checkJsonValue = (input: JsonValue): Decoded<JsonValue> =>
  catchRefusal(() => {
    const value = canonicalValue(input, 0);

    return utf8Length(stringifyJson(value)) > JSON_MAX_BYTES
      ? refuse("tooLarge", "JSON values are limited to 1 MiB.")
      : ok(value);
  });
