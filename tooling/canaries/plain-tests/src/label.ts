import { Option, Schema } from "effect";

/** A non-empty label. */
export const Label = Schema.NonEmptyString;

/**
 * Keeps a text only when it is a valid label.
 *
 * @param text - The candidate label.
 * @returns The label, or none.
 */
export const labelOrNone = (text: string): Option.Option<string> =>
  Option.filter(Option.some(text), Schema.is(Label));
