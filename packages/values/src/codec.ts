/**
 * Canonical JSON codecs per field type (Contracts 6.5).
 *
 * `decodeIn` converts a JSON value from a write payload into the TypeScript
 * value under the field's type and settings; `encodeOut` produces the
 * canonical JSON of a stored value. JSON numbers are refused for big integer
 * and decimal, which travel as strings; text gets the write conversion of
 * Contracts 5.5; password and secret are write-only.
 *
 * Payloads must be parsed with `parseJson` (`@std/values/json`), which
 * enforces the json rules that a parsed value can no longer show.
 */
import { checkChoiceWrite, parseChoiceKey } from "./choice.ts";
import type { ChoiceList } from "./choice.ts";
import { formatDateTime, parseDateTime } from "./date-time.ts";
import { parseDate } from "./date.ts";
import {
  compareDecimals,
  fitDecimal,
  formatDecimal,
  isDecimal,
  parseDecimal,
  rescaleDecimal,
} from "./decimal.ts";
import type { Decimal } from "./decimal.ts";
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";
import { maxLengthOf } from "./field-type.ts";
import type { FieldKind, FieldType, FieldTypeOf } from "./field-type.ts";
import { isBigint, isNumber } from "./field-value.ts";
import type { DecodedInput, StoredValue } from "./field-value.ts";
import {
  checkInteger,
  compareBigIntegers,
  formatBigInteger,
  parseBigInteger,
} from "./integer.ts";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  isJsonValue,
} from "./json-value.ts";
import type { JsonValue } from "./json-value.ts";
import { checkJsonValue } from "./json.ts";
import { checkPasswordLength } from "./password.ts";
import { checkLength, convertLongText, convertSingleLineText } from "./text.ts";
import { parseUuid } from "./uuid.ts";
import { isSecretState, Plaintext } from "./write-only.ts";

/** A JSON value other than null. */
type PresentJson = Exclude<JsonValue, null>;

const wrongType = (expected: string): Decoded<never> =>
  refuse("wrongJsonType", `Expected ${expected}.`);

const decodeText = (
  type: FieldTypeOf<"text" | "longText">,
  json: PresentJson
): Decoded<string | null> => {
  if (!isJsonString(json)) {
    return wrongType("a string");
  }

  const converted =
    type.kind === "text"
      ? convertSingleLineText(json, type.textPolicy)
      : convertLongText(json, type.textPolicy);

  if (!converted.ok || converted.value === null) {
    return converted;
  }

  if (type.nonBlank === true && converted.value.trim() === "") {
    return refuse("emptyNotAllowed", "This field requires non-blank text.");
  }

  return checkLength(converted.value, maxLengthOf(type));
};

const checkBounds = <A>(
  value: A,
  bounds: { readonly min: A | undefined; readonly max: A | undefined },
  compare: (left: A, right: A) => number
): Decoded<A> => {
  if (bounds.min !== undefined && compare(value, bounds.min) < 0) {
    return refuse("belowMinimum", "The value is below this field's minimum.");
  }

  if (bounds.max !== undefined && compare(value, bounds.max) > 0) {
    return refuse("aboveMaximum", "The value is above this field's maximum.");
  }

  return ok(value);
};

const compareNumbers = (left: number, right: number): number => left - right;

const decodeInteger = (
  type: FieldTypeOf<"integer">,
  json: PresentJson
): Decoded<number> => {
  if (!isJsonNumber(json)) {
    return wrongType("a JSON number");
  }

  const checked = checkInteger(json);

  return checked.ok
    ? checkBounds(
        checked.value,
        { max: type.max, min: type.min },
        compareNumbers
      )
    : checked;
};

const bigintBound = (bound: string | undefined): bigint | undefined =>
  bound === undefined ? undefined : BigInt(bound);

const decodeBigInteger = (
  type: FieldTypeOf<"bigInteger">,
  json: PresentJson
): Decoded<bigint> => {
  if (!isJsonString(json)) {
    return wrongType(
      'a string such as "9007199254740993"; JSON numbers lose precision'
    );
  }

  const parsed = parseBigInteger(json);

  return parsed.ok
    ? checkBounds(
        parsed.value,
        { max: bigintBound(type.max), min: bigintBound(type.min) },
        compareBigIntegers
      )
    : parsed;
};

const decimalBound = (bound: string | undefined): Decimal | undefined => {
  if (bound === undefined) {
    return undefined;
  }

  const parsed = parseDecimal(bound);

  return parsed.ok ? parsed.value : undefined;
};

const decodeDecimal = (
  type: FieldTypeOf<"decimal">,
  json: PresentJson
): Decoded<Decimal> => {
  if (!isJsonString(json)) {
    return wrongType('a string such as "12.50"; JSON numbers lose precision');
  }

  const parsed = parseDecimal(json);

  if (!parsed.ok) {
    return parsed;
  }

  const fitted = fitDecimal(parsed.value, type.precision, type.scale);

  return fitted.ok
    ? checkBounds(
        fitted.value,
        { max: decimalBound(type.max), min: decimalBound(type.min) },
        compareDecimals
      )
    : fitted;
};

const decodeString = <A>(
  json: PresentJson,
  parse: (text: string) => Decoded<A>
): Decoded<A> => (isJsonString(json) ? parse(json) : wrongType("a string"));

const decodeWriteOnly = (
  json: PresentJson,
  password: boolean
): Decoded<Plaintext> => {
  if (!isJsonString(json)) {
    return wrongType("a string");
  }

  if (json === "") {
    return refuse("emptyNotAllowed", "Send null to clear the value.");
  }

  if (!json.isWellFormed() || json.includes("\0")) {
    return refuse(
      "notWellFormed",
      "The value must be well-formed Unicode without U+0000."
    );
  }

  if (password) {
    const checked = checkPasswordLength(json);

    if (!checked.ok) {
      return checked;
    }
  }

  return ok(new Plaintext(json));
};

const decodeCondition = (json: PresentJson): Decoded<JsonValue> => {
  const checked = checkJsonValue(json);

  return !checked.ok || isJsonObject(checked.value)
    ? checked
    : wrongType("a condition object");
};

const decodePresent = (
  type: FieldType,
  json: PresentJson
): Decoded<DecodedInput> => {
  switch (type.kind) {
    case "text":
    case "longText": {
      return decodeText(type, json);
    }

    case "integer": {
      return decodeInteger(type, json);
    }

    case "bigInteger": {
      return decodeBigInteger(type, json);
    }

    case "decimal": {
      return decodeDecimal(type, json);
    }

    case "boolean": {
      return isJsonBoolean(json) ? ok(json) : wrongType("true or false");
    }

    case "date": {
      return decodeString(json, parseDate);
    }

    case "dateTime": {
      return decodeString(json, parseDateTime);
    }

    case "choice": {
      return decodeString(json, parseChoiceKey);
    }

    case "reference":
    case "uuid": {
      return decodeString(json, parseUuid);
    }

    case "password":
    case "secret": {
      return decodeWriteOnly(json, type.kind === "password");
    }

    case "json": {
      return checkJsonValue(json);
    }

    case "condition": {
      return decodeCondition(json);
    }

    default: {
      return type satisfies never;
    }
  }
};

/**
 * Converts a payload value under the field's type and settings.
 *
 * - `null` clears the field (Contracts 6.7), except for boolean, which is
 *   never null (`nullNotAllowed`). For json, `null` is SQL NULL.
 * - Text converts per Contracts 5.5; `""` and whitespace become null.
 * - Choice keys are checked for format only; see {@link decodeChoiceWrite}.
 * - Condition values are checked as JSON objects only; the AST check against
 *   the field's profile and class belongs to `@std/conditions`.
 *
 * @param type - The field type with its settings.
 * @param json - The payload value, parsed with `parseJson`. Absent keys are
 *   handled by `@std/values/write`.
 * @returns The input value or null, or an `InvalidValue`.
 */
export function decodeIn<K extends FieldKind>(
  type: FieldTypeOf<K>,
  json: JsonValue
): Decoded<DecodedInput<K>>;
/**
 * Converts a payload value under the field's type and settings.
 *
 * @param type - The field type with its settings.
 * @param json - The payload value, parsed with `parseJson`.
 * @returns The input value or null, or an `InvalidValue`.
 */
export function decodeIn(
  type: FieldType,
  json: JsonValue
): Decoded<DecodedInput>;
/**
 * Converts a payload value under the field's type and settings.
 *
 * @param type - The field type with its settings.
 * @param json - The payload value, parsed with `parseJson`.
 * @returns The input value or null, or an `InvalidValue`.
 */
export function decodeIn(
  type: FieldType,
  json: JsonValue
): Decoded<DecodedInput> {
  if (json === null) {
    return type.kind === "boolean"
      ? refuse("nullNotAllowed", "Booleans are never null; send true or false.")
      : ok(null);
  }

  return decodePresent(type, json);
}

/**
 * Converts a choice and checks it against the field's choices: active keys,
 * or the retired key already stored.
 *
 * @param json - The payload value.
 * @param choices - The field's choice list.
 * @param stored - The stored key before this write, or null on create.
 * @returns The key or null, or an `InvalidValue`.
 */
export const decodeChoiceWrite = (
  json: JsonValue,
  choices: ChoiceList,
  stored: string | null
): Decoded<string | null> => {
  const decoded = decodeIn<"choice">({ kind: "choice" }, json);

  if (!decoded.ok || decoded.value === null) {
    return decoded;
  }

  return checkChoiceWrite(decoded.value, choices, stored);
};

// A stored value that does not belong to its field's kind is a defect in
// the caller, never data to reinterpret; the message names the kind only.
const kindMismatch = (kind: FieldKind): never => {
  throw new TypeError(`encodeOut: the value is not a stored ${kind} value.`);
};

const encodeJsonKind = (kind: FieldKind, value: StoredValue): JsonValue =>
  isJsonValue(value) ? value : kindMismatch(kind);

// Dispatches on the field kind alone: a json value shaped like
// {"set": true} must come out whole, so no branch looks at the shape.
const encodePresent = (type: FieldType, value: StoredValue): JsonValue => {
  const { kind } = type;

  if (kind === "password" || kind === "secret") {
    return isSecretState(value) ? { set: value.set } : kindMismatch(kind);
  }

  if (kind === "bigInteger") {
    return isBigint(value) ? formatBigInteger(value) : kindMismatch(kind);
  }

  if (type.kind === "decimal") {
    return isDecimal(value)
      ? formatDecimal(rescaleDecimal(value, type.scale) ?? value)
      : kindMismatch(kind);
  }

  if (kind === "dateTime") {
    return isNumber(value) ? formatDateTime(value) : kindMismatch(kind);
  }

  // Every other kind stores its canonical JSON as is.
  return encodeJsonKind(kind, value);
};

/**
 * The canonical JSON of a stored value. Serialize json values with
 * `stringifyJson` to keep jsonb's key order.
 *
 * @param type - The field type with its settings.
 * @param value - The stored value, or null.
 * @returns Canonical JSON: big integers and decimals as strings (decimals
 *   with exactly the field's scale), date-times as `...sssZ`, password and
 *   secret as `{"set": bool}` (`{"set": false}` when null).
 */
export function encodeOut<K extends FieldKind>(
  type: FieldTypeOf<K>,
  value: StoredValue<K> | null
): JsonValue;
/**
 * The canonical JSON of a stored value.
 *
 * @param type - The field type with its settings.
 * @param value - The stored value, or null.
 * @returns Canonical JSON.
 */
export function encodeOut(
  type: FieldType,
  value: StoredValue | null
): JsonValue;
/**
 * The canonical JSON of a stored value.
 *
 * @param type - The field type with its settings.
 * @param value - The stored value, or null.
 * @returns Canonical JSON.
 */
export function encodeOut(
  type: FieldType,
  value: StoredValue | null
): JsonValue {
  if (value === null) {
    return type.kind === "password" || type.kind === "secret"
      ? { set: false }
      : null;
  }

  return encodePresent(type, value);
}

/**
 * The value a create stores when the payload omits the field and there is no
 * default: false for boolean, null otherwise (Contracts 6.7).
 *
 * @param kind - The field kind.
 * @returns The empty value.
 */
export const emptyValue = (kind: FieldKind): false | null =>
  kind === "boolean" ? false : null;
