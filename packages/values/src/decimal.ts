/**
 * Exact decimals (Contracts 5.6): `{ coefficient, scale }` is the value
 * `coefficient * 10^-scale`. Nothing here rounds: rescaling to fewer fraction
 * digits succeeds only when the dropped digits are zero.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

/** An exact decimal: `coefficient * 10^-scale`, with `scale >= 0`. */
export interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

/** The largest precision a decimal field may declare. */
export const DECIMAL_MAX_PRECISION = 38;

/** The most digits a decimal literal may have (Contracts 5.6). */
export const DECIMAL_LITERAL_MAX_DIGITS = 100;

const DECIMAL_TEXT = /^(?<sign>-?)(?<integer>\d+)(?:\.(?<fraction>\d+))?$/u;
const TEN = 10n;

/**
 * Builds a decimal.
 *
 * @param coefficient - The unscaled digits.
 * @param scale - The number of fraction digits, a non-negative integer.
 * @returns The decimal.
 */
export const makeDecimal = (coefficient: bigint, scale: number): Decimal => ({
  coefficient,
  scale,
});

/**
 * Parses `-?digits(.digits)?`. The scale is the number of fraction digits
 * written, so `"1.500"` has scale 3. `-0` is zero.
 *
 * @param input - The decimal text.
 * @returns The decimal, or `invalidFormat` or `tooManyDigits` (more than 100
 *   digits).
 */
export const parseDecimal = (input: string): Decoded<Decimal> => {
  const groups = DECIMAL_TEXT.exec(input)?.groups;

  if (groups === undefined) {
    return refuse(
      "invalidFormat",
      "Decimals are written as digits with an optional fraction, such as -12.50."
    );
  }

  const integer = groups.integer ?? "";
  const fraction = groups.fraction ?? "";

  if (integer.length + fraction.length > DECIMAL_LITERAL_MAX_DIGITS) {
    return refuse("tooManyDigits", "Decimals have at most 100 digits.");
  }

  const magnitude = BigInt(`${integer}${fraction}`);

  return ok(
    makeDecimal(groups.sign === "-" ? -magnitude : magnitude, fraction.length)
  );
};

/**
 * Formats a decimal with exactly its scale's fraction digits.
 *
 * @param value - The decimal.
 * @returns Text such as `-12.50`, or `0` for zero at scale 0.
 */
export const formatDecimal = (value: Decimal): string => {
  const negative = value.coefficient < 0n;

  const digits = (negative ? -value.coefficient : value.coefficient)
    .toString()
    .padStart(value.scale + 1, "0");

  const sign = negative ? "-" : "";

  if (value.scale === 0) {
    return `${sign}${digits}`;
  }

  const point = digits.length - value.scale;

  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/**
 * Rescales a decimal without rounding.
 *
 * @param value - The decimal.
 * @param scale - The target number of fraction digits.
 * @returns The same value at the new scale, or undefined when that would drop
 *   a non-zero digit.
 */
export const rescaleDecimal = (
  value: Decimal,
  scale: number
): Decimal | undefined => {
  if (scale >= value.scale) {
    return makeDecimal(
      value.coefficient * TEN ** BigInt(scale - value.scale),
      scale
    );
  }

  const divisor = TEN ** BigInt(value.scale - scale);

  return value.coefficient % divisor === 0n
    ? makeDecimal(value.coefficient / divisor, scale)
    : undefined;
};

/**
 * Removes trailing zero fraction digits.
 *
 * @param value - The decimal.
 * @returns The same value at the smallest exact scale.
 */
export const normalizeDecimal = (value: Decimal): Decimal => {
  let { coefficient, scale } = value;

  while (scale > 0 && coefficient % TEN === 0n) {
    coefficient /= TEN;
    scale -= 1;
  }

  return makeDecimal(coefficient, scale);
};

/**
 * Orders two decimals by value, whatever their scales.
 *
 * @param left - A decimal.
 * @param right - A decimal.
 * @returns Negative, zero or positive.
 */
export const compareDecimals = (left: Decimal, right: Decimal): number => {
  const scale = Math.max(left.scale, right.scale);
  const a = left.coefficient * TEN ** BigInt(scale - left.scale);
  const b = right.coefficient * TEN ** BigInt(scale - right.scale);

  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
};

/**
 * Value equality, so 1.5 equals 1.50.
 *
 * @param left - A decimal.
 * @param right - A decimal.
 * @returns True when both denote the same number.
 */
export const decimalsEqual = (left: Decimal, right: Decimal): boolean =>
  compareDecimals(left, right) === 0;

/**
 * The number of digits left of the point, at least 0.
 *
 * @param value - The decimal.
 * @returns How many integer digits the value needs; 0 when the absolute value is below 1.
 */
export const integerDigits = (value: Decimal): number => {
  const magnitude =
    value.coefficient < 0n ? -value.coefficient : value.coefficient;

  const integerPart = magnitude / TEN ** BigInt(value.scale);

  return integerPart === 0n ? 0 : integerPart.toString().length;
};

/**
 * Converts a field's stored value to the field's scale and checks
 * `numeric(precision, scale)`: never rounded.
 *
 * @param value - The decimal.
 * @param precision - Total digits, 1 to 38.
 * @param scale - Fraction digits, 0 to precision.
 * @returns The value at exactly `scale`, or `inexactScale` or `outOfRange`.
 */
export const fitDecimal = (
  value: Decimal,
  precision: number,
  scale: number
): Decoded<Decimal> => {
  const rescaled = rescaleDecimal(value, scale);

  if (rescaled === undefined) {
    return refuse(
      "inexactScale",
      `This field keeps ${scale} fraction digits; the value would need rounding.`
    );
  }

  if (integerDigits(rescaled) > precision - scale) {
    return refuse(
      "outOfRange",
      `This field holds at most ${precision - scale} digits before the point.`
    );
  }

  return ok(rescaled);
};

/**
 * Converts an integer to a decimal at scale 0.
 *
 * @param value - An integer as a bigint or a safe integer number.
 * @returns The decimal.
 */
export const decimalFromInteger = (value: bigint | number): Decimal =>
  makeDecimal(BigInt(value), 0);

/**
 * Whether a value is a {@link Decimal}.
 *
 * @param value - Any value.
 * @returns True for objects with a bigint coefficient and a non-negative
 *   integer scale.
 */
export const isDecimal = (value: unknown): value is Decimal => {
  const candidate =
    typeof value === "object" &&
    value !== null &&
    "coefficient" in value &&
    "scale" in value;

  return (
    candidate &&
    typeof value.coefficient === "bigint" &&
    Number.isSafeInteger(value.scale) &&
    Number(value.scale) >= 0
  );
};
