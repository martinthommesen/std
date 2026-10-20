/**
 * Integer (`int4`, a JS `number`) and big integer (`int8`, a `bigint`)
 * values (Contracts 5.6, 6.5). Big integers travel as strings
 * `-?(0|[1-9][0-9]*)`; JSON numbers are refused for them.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

/** The smallest `int4`. */
export const INTEGER_MIN = -2_147_483_648;

/** The largest `int4`. */
export const INTEGER_MAX = 2_147_483_647;

/** The smallest `int8`. */
export const BIG_INTEGER_MIN = -9_223_372_036_854_775_808n;

/** The largest `int8`. */
export const BIG_INTEGER_MAX = 9_223_372_036_854_775_807n;

/** The longest big integer text accepted, leading zeros included. */
const BIG_INTEGER_MAX_DIGITS = 100;

const BIG_INTEGER_TEXT = /^-?\d+$/u;

/**
 * Checks a JSON number as an `int4`.
 *
 * @param input - The number.
 * @returns The integer (`-0` becomes `0`), or `notInteger` or `outOfRange`.
 */
export const checkInteger = (input: number): Decoded<number> => {
  if (!Number.isInteger(input)) {
    return refuse("notInteger", "This field holds whole numbers.");
  }

  if (input < INTEGER_MIN || input > INTEGER_MAX) {
    return refuse(
      "outOfRange",
      "Integers are between -2147483648 and 2147483647."
    );
  }

  return ok(input === 0 ? 0 : input);
};

/**
 * Parses big integer text.
 *
 * @param input - Text such as `-9007199254740993`.
 * @returns The bigint, or `invalidFormat` or `outOfRange`.
 */
export const parseBigInteger = (input: string): Decoded<bigint> => {
  if (!BIG_INTEGER_TEXT.test(input) || input.length > BIG_INTEGER_MAX_DIGITS) {
    return refuse(
      "invalidFormat",
      'Big integers are written as a string of digits, such as "-12".'
    );
  }

  const value = BigInt(input);

  if (value < BIG_INTEGER_MIN || value > BIG_INTEGER_MAX) {
    return refuse(
      "outOfRange",
      "Big integers are between -9223372036854775808 and 9223372036854775807."
    );
  }

  return ok(value);
};

/**
 * Formats a big integer canonically.
 *
 * @param value - The bigint.
 * @returns Text matching `-?(0|[1-9][0-9]*)`.
 */
export const formatBigInteger = (value: bigint): string => value.toString();

/**
 * Orders two bigints.
 *
 * @param left - A bigint.
 * @param right - A bigint.
 * @returns Negative, zero or positive.
 */
export const compareBigIntegers = (left: bigint, right: bigint): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};
