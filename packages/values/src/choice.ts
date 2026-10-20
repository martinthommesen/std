/**
 * Choice keys (Contracts 6.5): 1 to 63 characters of `[a-z0-9_]`, starting
 * with a letter or digit. Keys compare case-sensitively. The record service
 * validates keys against the field's choice list, so lists change without DDL.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

const CHOICE_KEY = /^[\da-z][\d_a-z]{0,62}$/u;

/** The choices of one field, split by state. */
export interface ChoiceList {
  /** Keys that may be written. */
  readonly active: ReadonlySet<string>;
  /** Keys that still exist but may no longer be written. */
  readonly retired: ReadonlySet<string>;
}

/**
 * Whether a string has the choice key format.
 *
 * @param input - The string to test.
 * @returns True for 1 to 63 characters of `[a-z0-9_]` not starting with `_`.
 */
export const isChoiceKey = (input: string): boolean => CHOICE_KEY.test(input);

/**
 * Checks the key format.
 *
 * @param input - The key.
 * @returns The key, or `invalidChoiceKey`.
 */
export const parseChoiceKey = (input: string): Decoded<string> =>
  isChoiceKey(input)
    ? ok(input)
    : refuse(
        "invalidChoiceKey",
        "Choice keys are 1 to 63 characters of a-z, 0-9 and _, starting with a letter or digit."
      );

/**
 * Checks a written key against the field's choices: an active key is
 * accepted, and a retired key only when it is the value already stored.
 *
 * @param key - A key with a valid format.
 * @param choices - The field's choice list.
 * @param stored - The value stored before this write, or null on create.
 * @returns The key, or `unknownChoice` or `retiredChoice`.
 */
export const checkChoiceWrite = (
  key: string,
  choices: ChoiceList,
  stored: string | null
): Decoded<string> => {
  if (choices.active.has(key) || (key === stored && choices.retired.has(key))) {
    return ok(key);
  }

  return choices.retired.has(key)
    ? refuse(
        "retiredChoice",
        "This choice is retired and can no longer be chosen."
      )
    : refuse("unknownChoice", "This field has no such choice.");
};

/**
 * Checks a condition literal against the field's choices: active and retired
 * keys are both allowed (Contracts 5.2).
 *
 * @param key - A key with a valid format.
 * @param choices - The field's choice list.
 * @returns The key, or `unknownChoice`.
 */
export const checkChoiceLiteral = (
  key: string,
  choices: ChoiceList
): Decoded<string> =>
  choices.active.has(key) || choices.retired.has(key)
    ? ok(key)
    : refuse("unknownChoice", "This field has no such choice.");
