/**
 * The typed field error every conversion in this package returns, and the
 * small result type that carries it.
 *
 * Messages never contain the value that was refused, so an error can be
 * returned, logged or stored without leaking a password, a secret or a hidden
 * value (Contracts 4.3).
 */
import {
  Literals,
  optionalKey,
  String as SchemaString,
  TaggedError,
} from "effect/Schema";

/** Every reason an `InvalidValue` can carry. */
export const InvalidValueReasonSchema = Literals([
  "wrongJsonType",
  "nullNotAllowed",
  "emptyNotAllowed",
  "notWellFormed",
  "nulCharacter",
  "controlCharacter",
  "tooLong",
  "notInteger",
  "outOfRange",
  "belowMinimum",
  "aboveMaximum",
  "invalidFormat",
  "tooManyDigits",
  "inexactScale",
  "invalidDate",
  "invalidDateTime",
  "subMillisecond",
  "leapSecond",
  "invalidUuid",
  "invalidChoiceKey",
  "unknownChoice",
  "retiredChoice",
  "invalidJson",
  "duplicateKey",
  "inexactNumber",
  "unsafeInteger",
  "tooDeep",
  "tooLarge",
  "emptyLiteral",
  "emptyNeedle",
  "notComparable",
  "invalidCondition",
]);

/** A reason code of {@link InvalidValue}. */
export type InvalidValueReason = typeof InvalidValueReasonSchema.Type;

/**
 * A value that does not convert under its field type's rules (Contracts 3.8,
 * listed inside `ValidationFailed`).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class InvalidValue extends TaggedError<
  InvalidValue,
  { readonly brand: unique symbol }
>()("InvalidValue", {
  hint: optionalKey(SchemaString),
  message: SchemaString,
  reason: InvalidValueReasonSchema,
}) {}

/** A successful conversion. */
export interface Converted<A> {
  readonly ok: true;
  readonly value: A;
}

/** A refused conversion. */
export interface Refused {
  readonly ok: false;
  readonly error: InvalidValue;
}

/** The result of every conversion in this package. */
export type Decoded<A> = Converted<A> | Refused;

/**
 * Wraps a converted value.
 *
 * @param value - The converted value.
 * @returns A success.
 */
export const ok = <A>(value: A): Converted<A> => ({ ok: true, value });

/**
 * Builds a refusal.
 *
 * @param reason - The reason code.
 * @param message - A message that never contains the refused value.
 * @param hint - An optional hint on what to send instead.
 * @returns A refusal carrying an `InvalidValue`.
 */
export const refuse = (
  reason: InvalidValueReason,
  message: string,
  hint?: string
): Refused => ({
  error: new InvalidValue(
    hint === undefined ? { message, reason } : { hint, message, reason }
  ),
  ok: false,
});

/**
 * Returns the converted value, or throws the `InvalidValue`. For tests and
 * for values that are valid by construction.
 *
 * @param decoded - A conversion result.
 * @returns The converted value.
 */
export const getOrThrow = <A>(decoded: Decoded<A>): A => {
  if (decoded.ok) {
    return decoded.value;
  }

  throw decoded.error;
};
