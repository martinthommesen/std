/**
 * Text write conversion (Contracts 5.5), shared by server and browser.
 *
 * Both policies validate Unicode, U+0000, the single-line repertoire and
 * code-point length. `freeText` retains every accepted scalar, including
 * empty/whitespace strings and CR/LF sequences in long text. The absent or
 * `normalized` policy retains NFC, identifier trimming and legacy blank/null
 * conversion. Pattern needles follow the field policy without trimming.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded, Refused } from "./field-error.ts";

/** The default maximum length of a text field, in code points. */
export const TEXT_DEFAULT_MAX_LENGTH = 255;

/** The largest maximum length a text field may declare, in code points. */
export const TEXT_MAX_LENGTH_LIMIT = 4000;

/** The maximum length of long text, in code points. */
export const LONG_TEXT_MAX_LENGTH = 1_000_000;

/**
 * ECMAScript WhiteSpace/LineTerminator set for SQL adapters of trim-based checks.
 * https://tc39.es/ecma262/#sec-white-space and #sec-line-terminators.
 */
export const TEXT_TRIM_CHARACTERS =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";

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
 * Write conversion for single-line text.
 *
 * @param input - The text as received.
 * @param policy - Explicit scalar preservation or the normalized identifier policy.
 * @returns The accepted text, null for normalized empty text, or `notWellFormed`,
 *   `nulCharacter` or `controlCharacter`. Length is checked by the caller.
 */
export const convertSingleLineText = (
  input: string,
  policy: "normalized" | "freeText" = "normalized"
): Decoded<string | null> => {
  const encodingError = checkEncoding(input);

  if (encodingError !== undefined) {
    return encodingError;
  }

  const normalized = policy === "freeText" ? input : input.normalize("NFC");

  if (hasRefusedSingleLineCharacter(normalized)) {
    return refuse(
      "controlCharacter",
      "Single-line text cannot contain line breaks or control characters other than tab."
    );
  }

  if (policy === "freeText") {
    return ok(input);
  }

  const trimmed = normalized.trim();

  return ok(trimmed === "" ? null : trimmed);
};

/**
 * Write conversion for long text.
 *
 * @param input - The text as received.
 * @param policy - Explicit scalar preservation or the normalized identifier policy.
 * @returns The accepted text (normalized policy converts line endings and blanks), or
 *   `notWellFormed` or `nulCharacter`. Length is checked by the caller.
 */
export const convertLongText = (
  input: string,
  policy: "normalized" | "freeText" = "normalized"
): Decoded<string | null> => {
  const encodingError = checkEncoding(input);

  if (encodingError !== undefined) {
    return encodingError;
  }

  if (policy === "freeText") {
    return ok(input);
  }

  const converted = input.normalize("NFC").replaceAll(CR_LF_OR_CR, "\n");

  return ok(converted.trim() === "" ? null : converted);
};

/**
 * Conversion for pattern needles (the caller counts length).
 * Needles are not trimmed and may be empty.
 *
 * @param input - The needle as written.
 * @param policy - The field's scalar policy.
 * @returns The policy-converted needle, or `notWellFormed` or `nulCharacter`.
 */
export const convertNeedle = (
  input: string,
  policy: "normalized" | "freeText" = "normalized"
): Decoded<string> => {
  const encodingError = checkEncoding(input);

  return (
    encodingError ?? ok(policy === "freeText" ? input : input.normalize("NFC"))
  );
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
): Decoded<string> => {
  const length = codePointLength(text);

  return length <= maxLength
    ? ok(text)
    : refuse(
        "tooLong",
        `maxLength=${maxLength} code points; asked for ${length}.`
      );
};
