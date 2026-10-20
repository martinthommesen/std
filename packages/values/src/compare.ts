/**
 * Type equality `≡`, ordering and exact stored equality (Contracts 5.4).
 *
 * - `≡`: text by key (fold unless case-sensitive); integer, big integer and
 *   decimal as one numeric class compared exactly (1.5 ≡ 1.50); date by
 *   calendar date; date-time by millisecond; choice by key, case-sensitive;
 *   reference and uuid by UUID; boolean by value.
 * - Order: integer, big integer, decimal (across the numeric class), date,
 *   date-time.
 * - Stored equality, for `changed`: exact values ("alice" to "Alice" is a
 *   change), json by jsonb equality.
 *
 * Equality and order take non-null values; null handling belongs to the
 * operator (Contracts 5.4 table).
 */
import { compareDates, isIsoDate } from "./date.ts";
import type { IsoDate } from "./date.ts";
import {
  compareDecimals,
  decimalFromInteger,
  decimalsEqual,
  isDecimal,
} from "./decimal.ts";
import type { Decimal } from "./decimal.ts";
import { isCaseSensitive } from "./field-type.ts";
import type { FieldKind, FieldType } from "./field-type.ts";
import { isBigint, isBoolean, isNumber, isString } from "./field-value.ts";
import type { StoredValue } from "./field-value.ts";
import { textKey } from "./fold.ts";
import { isJsonValue } from "./json-value.ts";
import { jsonbEquals } from "./jsonb.ts";
import { isPlaintext, isSecretState } from "./write-only.ts";
import type { Plaintext } from "./write-only.ts";

/** A numeric-class value. */
export type NumericValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "bigInteger"; readonly value: bigint }
  | { readonly kind: "decimal"; readonly value: Decimal };

/** A non-null value of a kind that has equality, tagged with its class. */
export type ComparableValue =
  | {
      readonly kind: "text" | "longText";
      readonly value: string;
      readonly caseSensitive: boolean;
    }
  | NumericValue
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: IsoDate }
  | { readonly kind: "dateTime"; readonly value: number }
  | { readonly kind: "choice" | "reference" | "uuid"; readonly value: string };

const textValue = (
  type: FieldType,
  value: StoredValue
): ComparableValue | undefined => {
  if (!isString(value)) {
    return undefined;
  }

  switch (type.kind) {
    case "text":
    case "longText": {
      return { caseSensitive: isCaseSensitive(type), kind: type.kind, value };
    }

    case "date": {
      return isIsoDate(value) ? { kind: "date", value } : undefined;
    }

    case "choice":
    case "reference":
    case "uuid": {
      return { kind: type.kind, value };
    }

    case "integer":
    case "bigInteger":
    case "decimal":
    case "boolean":
    case "dateTime":
    case "password":
    case "secret":
    case "json":
    case "condition": {
      return undefined;
    }

    default: {
      return type satisfies never;
    }
  }
};

/**
 * Tags a stored value with its comparison class.
 *
 * @param type - The field type.
 * @param value - A non-null stored value of that type.
 * @returns The comparable value, or undefined for kinds without equality
 *   (password, secret, json, condition) or a value of the wrong kind.
 */
export const comparableValue = (
  type: FieldType,
  value: StoredValue
): ComparableValue | undefined => {
  if (type.kind === "integer" && isNumber(value)) {
    return { kind: "integer", value };
  }

  if (type.kind === "bigInteger" && isBigint(value)) {
    return { kind: "bigInteger", value };
  }

  if (type.kind === "decimal" && isDecimal(value)) {
    return { kind: "decimal", value };
  }

  if (type.kind === "dateTime" && isNumber(value)) {
    return { kind: "dateTime", value };
  }

  if (type.kind === "boolean" && isBoolean(value)) {
    return { kind: "boolean", value };
  }

  return textValue(type, value);
};

/**
 * Converts a numeric-class value to a decimal.
 *
 * @param numeric - An integer, big integer or decimal value.
 * @returns The exact decimal.
 */
export const numericToDecimal = (numeric: NumericValue): Decimal =>
  numeric.kind === "decimal"
    ? numeric.value
    : decimalFromInteger(numeric.value);

const asNumeric = (value: ComparableValue): NumericValue | undefined => {
  switch (value.kind) {
    case "integer":
    case "bigInteger":
    case "decimal": {
      return value;
    }

    case "text":
    case "longText":
    case "boolean":
    case "date":
    case "dateTime":
    case "choice":
    case "reference":
    case "uuid": {
      return undefined;
    }

    default: {
      return value satisfies never;
    }
  }
};

const classOf = (value: ComparableValue): string => {
  switch (value.kind) {
    case "integer":
    case "bigInteger":
    case "decimal": {
      return "numeric";
    }

    case "text":
    case "longText": {
      return "text";
    }

    case "reference":
    case "uuid": {
      return "uuid";
    }

    case "boolean":
    case "date":
    case "dateTime":
    case "choice": {
      return value.kind;
    }

    default: {
      return value satisfies never;
    }
  }
};

const keyOf = (value: ComparableValue): ComparableValue["value"] =>
  value.kind === "text" || value.kind === "longText"
    ? textKey(value.value, value.caseSensitive)
    : value.value;

/**
 * Type equality `≡`. Each text side is keyed with its own field's case
 * setting, as the SQL `k(f) = k(g)` does.
 *
 * @param left - A comparable value.
 * @param right - A comparable value.
 * @returns True when both are in one comparison class and `≡`.
 */
export const typeEquals = (
  left: ComparableValue,
  right: ComparableValue
): boolean => {
  const leftNumeric = asNumeric(left);
  const rightNumeric = asNumeric(right);

  if (leftNumeric !== undefined && rightNumeric !== undefined) {
    return decimalsEqual(
      numericToDecimal(leftNumeric),
      numericToDecimal(rightNumeric)
    );
  }

  return classOf(left) === classOf(right) && keyOf(left) === keyOf(right);
};

/**
 * Orders two values of ordered kinds (integer, big integer, decimal, date,
 * date-time) within one comparison class.
 *
 * @param left - A comparable value.
 * @param right - A comparable value.
 * @returns Negative, zero or positive; undefined when the pair has no order.
 */
export const compareValues = (
  left: ComparableValue,
  right: ComparableValue
): number | undefined => {
  const leftNumeric = asNumeric(left);
  const rightNumeric = asNumeric(right);

  if (leftNumeric !== undefined && rightNumeric !== undefined) {
    return compareDecimals(
      numericToDecimal(leftNumeric),
      numericToDecimal(rightNumeric)
    );
  }

  if (left.kind === "date" && right.kind === "date") {
    return compareDates(left.value, right.value);
  }

  if (left.kind === "dateTime" && right.kind === "dateTime") {
    return Math.sign(left.value - right.value);
  }

  return undefined;
};

/** What `storedEquals` compares: a stored value, a new plaintext, or null. */
export type StoredOrPlaintext = StoredValue | Plaintext | null;

const writeOnlyEquals = (
  left: StoredOrPlaintext,
  right: StoredOrPlaintext
): boolean => {
  // A new plaintext is always a change: salted hashes cannot be compared.
  if (isPlaintext(left) || isPlaintext(right)) {
    return false;
  }

  return isSecretState(left) && isSecretState(right) && left.set === right.set;
};

/**
 * Exact stored equality, used by `changed` (Contracts 5.4) and by the save
 * pipeline's no-op check. Nulls equal each other only. Password and secret:
 * a proposed {@link Plaintext} always counts as a change.
 *
 * @param kind - The field kind.
 * @param left - The previous value or null.
 * @param right - The proposed value or null.
 * @returns True when nothing changed.
 */
export const storedEquals = (
  kind: FieldKind,
  left: StoredOrPlaintext,
  right: StoredOrPlaintext
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }

  if (kind === "password" || kind === "secret") {
    return writeOnlyEquals(left, right);
  }

  if (kind === "decimal") {
    return isDecimal(left) && isDecimal(right) && decimalsEqual(left, right);
  }

  if (
    (kind === "json" || kind === "condition") &&
    isJsonValue(left) &&
    isJsonValue(right)
  ) {
    return jsonbEquals(left, right);
  }

  return left === right;
};
