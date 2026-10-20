/**
 * Text write conversion (Contracts 5.5), shared by server and browser.
 *
 * 1. Refuse text that is not well-formed Unicode or contains U+0000.
 * 2. Normalize to NFC.
 * 3. Single-line text: refuse CR, LF, U+2028, U+2029 and control characters
 *    other than tab; trim with the ECMAScript `trim()` set; `""` becomes null.
 * 4. Long text: CRLF and CR become LF; no trimming; whitespace-only becomes
 *    null.
 * 5. Length is counted in code points.
 *
 * Needles for `contains`, `startsWith` and `endsWith` get steps 1, 2 and 5.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded, Refused } from "./field-error.ts";

/** The default maximum length of a text field, in code points. */
export const TEXT_DEFAULT_MAX_LENGTH = 255;

/** The largest maximum length a text field may declare, in code points. */
export const TEXT_MAX_LENGTH_LIMIT = 4000;

/** The maximum length of long text, in code points. */
export const LONG_TEXT_MAX_LENGTH = 1_000_000;

const LAST_BMP = 0xff_ff;
const TAB = 0x09;
const LAST_C0 = 0x1f;
const DELETE = 0x7f;
const LAST_C1 = 0x9f;
const LINE_SEPARATOR = 0x20_28;
const PARAGRAPH_SEPARATOR = 0x20_29;
const CR_LF_OR_CR = /\r\n?/gu;

/**
 * Counts code points (not UTF-16 code units).
 *
 * @param text - Well-formed text.
 * @returns The number of code points, as Postgres `char_length` counts them.
 */
export const codePointLength = (text: string): number => {
  let count = 0;

  for (let index = 0; index < text.length; index += 1) {
    if ((text.codePointAt(index) ?? 0) > LAST_BMP) {
      index += 1;
    }

    count += 1;
  }

  return count;
};

const checkEncoding = (input: string): Refused | undefined => {
  if (!input.isWellFormed()) {
    return refuse(
      "notWellFormed",
      "Text must be well-formed Unicode (no lone surrogates)."
    );
  }

  if (input.includes("\0")) {
    return refuse("nulCharacter", "Text cannot contain U+0000.");
  }

  return undefined;
};

const isRefusedInSingleLine = (codePoint: number): boolean => {
  const control =
    (codePoint <= LAST_C0 && codePoint !== TAB) ||
    (codePoint >= DELETE && codePoint <= LAST_C1);

  return (
    control || codePoint === LINE_SEPARATOR || codePoint === PARAGRAPH_SEPARATOR
  );
};

const hasRefusedSingleLineCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (isRefusedInSingleLine(text.codePointAt(index) ?? 0)) {
      return true;
    }
  }

  return false;
};

/**
 * Write conversion for single-line text (steps 1 to 3).
 *
 * @param input - The text as received.
 * @returns The stored text, null for empty, or `notWellFormed`,
 *   `nulCharacter` or `controlCharacter`. Length is checked by the caller.
 */
export const convertSingleLineText = (
  input: string
): Decoded<string | null> => {
  const encodingError = checkEncoding(input);

  if (encodingError !== undefined) {
    return encodingError;
  }

  const normalized = input.normalize("NFC");

  if (hasRefusedSingleLineCharacter(normalized)) {
    return refuse(
      "controlCharacter",
      "Single-line text cannot contain line breaks or control characters other than tab."
    );
  }

  const trimmed = normalized.trim();

  return ok(trimmed === "" ? null : trimmed);
};

/**
 * Write conversion for long text (steps 1, 2 and 4).
 *
 * @param input - The text as received.
 * @returns The stored text with LF line ends, null for whitespace-only, or
 *   `notWellFormed` or `nulCharacter`. Length is checked by the caller.
 */
export const convertLongText = (input: string): Decoded<string | null> => {
  const encodingError = checkEncoding(input);

  if (encodingError !== undefined) {
    return encodingError;
  }

  const converted = input.normalize("NFC").replaceAll(CR_LF_OR_CR, "\n");

  return ok(converted.trim() === "" ? null : converted);
};

/**
 * Conversion for pattern needles (steps 1 and 2; the caller counts length).
 * Needles are not trimmed and may be empty.
 *
 * @param input - The needle as written.
 * @returns The NFC needle, or `notWellFormed` or `nulCharacter`.
 */
export const convertNeedle = (input: string): Decoded<string> => {
  const encodingError = checkEncoding(input);

  return encodingError ?? ok(input.normalize("NFC"));
};

/**
 * Checks a converted value's length.
 *
 * @param text - Converted text.
 * @param maxLength - The limit in code points.
 * @returns The text, or `tooLong`.
 */
export const checkLength = (
  text: string,
  maxLength: number
): Decoded<string> =>
  codePointLength(text) <= maxLength
    ? ok(text)
    : refuse("tooLong", `Text is limited to ${maxLength} characters.`);
