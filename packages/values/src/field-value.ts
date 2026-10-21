/**
 * The TypeScript value of every field kind (Contracts 6.5), and guards to
 * tell them apart at run time.
 */
import type { IsoDate } from "./date.ts";
import type { Decimal } from "./decimal.ts";
import type { FieldKind } from "./field-type.ts";
import type { JsonValue } from "./json-value.ts";
import type { Uuid } from "./uuid.ts";
import type { Plaintext, SecretState } from "./write-only.ts";

/** The TypeScript value of each kind, as stored and read. */
export interface StoredValues {
  readonly text: string;
  readonly longText: string;
  readonly integer: number;
  readonly bigInteger: bigint;
  readonly decimal: Decimal;
  readonly boolean: boolean;
  readonly date: IsoDate;
  /** Epoch milliseconds. */
  readonly dateTime: number;
  readonly choice: string;
  readonly reference: Uuid;
  readonly uuid: Uuid;
  readonly password: SecretState;
  readonly secret: SecretState;
  readonly json: JsonValue;
  readonly condition: JsonValue;
}

/** The value of each kind on its way in: write-only kinds carry plaintext. */
export interface InputValues extends Omit<StoredValues, "password" | "secret"> {
  readonly password: Plaintext;
  readonly secret: Plaintext;
}

/** The stored value of a kind (all kinds by default). */
export type StoredValue<K extends FieldKind = FieldKind> = StoredValues[K];

/** The input value of a kind (all kinds by default). */
export type InputValue<K extends FieldKind = FieldKind> = InputValues[K];

/** What a write may carry for a field: its input value, or null to clear it. */
export type DecodedInput<
  K extends FieldKind = FieldKind,
> = InputValue<K> | null;

/**
 * Whether a value is a string.
 *
 * @param value - Any value.
 * @returns True for strings.
 */
export const isString = (value: unknown): value is string =>
  typeof value === "string";

/**
 * Whether a value is a number.
 *
 * @param value - Any value.
 * @returns True for numbers.
 */
export const isNumber = (value: unknown): value is number =>
  typeof value === "number";

/**
 * Whether a value is a bigint.
 *
 * @param value - Any value.
 * @returns True for bigints.
 */
export const isBigint = (value: unknown): value is bigint =>
  typeof value === "bigint";

/**
 * Whether a value is a boolean.
 *
 * @param value - Any value.
 * @returns True for booleans.
 */
export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
