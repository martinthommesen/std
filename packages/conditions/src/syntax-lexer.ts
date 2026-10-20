/**
 * The lexer of the condition text syntax (grammar in
 * `docs/decisions/0005-conditions.md`). It never throws: malformed input
 * becomes an `error` token with its position, which the parser reports.
 */
import type { Span } from "./issue.ts";

/** The words with a fixed meaning; field names spelled so are quoted. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  "all",
  "and",
  "any",
  "changed",
  "contains",
  "empty",
  "ends",
  "false",
  "in",
  "is",
  "me",
  "myGroups",
  "not",
  "now",
  "or",
  "previous",
  "starts",
  "today",
  "true",
  "with",
]);

/** Punctuation and operators. */
export type Punctuation =
  | "("
  | ")"
  | ","
  | "."
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-";

/** The kinds of tokens. */
export type TokenKind =
  | "word"
  | "quotedName"
  | "string"
  | "number"
  | "punctuation"
  | "end"
  | "error";

/** One token. */
export interface Token {
  readonly kind: TokenKind;
  /** The word, name, decoded string, digits or punctuation. */
  readonly text: string;
  readonly span: Span;
}

const WORD_START = /[A-Z_a-z]/u;
const WORD_PART = /\w/u;
const DIGIT = /\d/u;
const SPACE = /\s/u;
const HEX_DIGITS = /^[\dA-Fa-f]+$/u;
const MAX_CODE_POINT = 0x10_ff_ff;
const HEX = 16;
const SHORT_ESCAPE_DIGITS = 4;

const TWO_CHARACTER: ReadonlySet<string> = new Set(["!=", "<=", ">="]);

const ONE_CHARACTER: ReadonlySet<string> = new Set([
  "(",
  ")",
  ",",
  ".",
  "=",
  "<",
  ">",
  "+",
  "-",
]);

const SIMPLE_ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["`", "`"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

interface Cursor {
  readonly text: string;
  index: number;
}

type Scanned =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): Scanned => ({ message, ok: false });

const scanUnicodeEscape = (cursor: Cursor): Scanned => {
  const { text } = cursor;

  if (text[cursor.index] === "{") {
    const close = text.indexOf("}", cursor.index);
    const digits = close === -1 ? "" : text.slice(cursor.index + 1, close);
    const codePoint = Number.parseInt(digits, HEX);

    if (!HEX_DIGITS.test(digits) || codePoint > MAX_CODE_POINT) {
      return fail("A \\u{...} escape needs 1 to 6 hex digits up to 10FFFF.");
    }

    cursor.index = close + 1;

    return { ok: true, value: String.fromCodePoint(codePoint) };
  }

  const digits = text.slice(cursor.index, cursor.index + SHORT_ESCAPE_DIGITS);

  if (digits.length !== SHORT_ESCAPE_DIGITS || !HEX_DIGITS.test(digits)) {
    return fail("A \\u escape needs four hex digits.");
  }

  cursor.index += SHORT_ESCAPE_DIGITS;

  return {
    ok: true,
    value: String.fromCodePoint(Number.parseInt(digits, HEX)),
  };
};

const scanEscape = (cursor: Cursor): Scanned => {
  if (cursor.index >= cursor.text.length) {
    return fail("The escape at the end of the text is not complete.");
  }

  const character = cursor.text[cursor.index] ?? "";
  cursor.index += 1;

  if (character === "u") {
    return scanUnicodeEscape(cursor);
  }

  const simple = SIMPLE_ESCAPES.get(character);

  return simple === undefined
    ? fail('Unknown escape; use \\", \\\\, \\`, \\n, \\r, \\t or \\u.')
    : { ok: true, value: simple };
};

// Scans a "string" or a `quoted name` after its opening delimiter.
const scanQuoted = (cursor: Cursor, delimiter: string): Scanned => {
  let value = "";

  while (cursor.index < cursor.text.length) {
    const character = cursor.text[cursor.index] ?? "";
    cursor.index += 1;

    if (character === delimiter) {
      return { ok: true, value };
    }

    if (character === "\\") {
      const escaped = scanEscape(cursor);

      if (!escaped.ok) {
        return escaped;
      }

      value += escaped.value;
    } else {
      value += character;
    }
  }

  return fail(
    delimiter === '"' ? "The string is not closed." : "The name is not closed."
  );
};

const scanWhile = (cursor: Cursor, pattern: RegExp): string => {
  const start = cursor.index;

  while (pattern.test(cursor.text[cursor.index] ?? "")) {
    cursor.index += 1;
  }

  return cursor.text.slice(start, cursor.index);
};

const scanNumber = (cursor: Cursor): string => {
  let digits = scanWhile(cursor, DIGIT);

  if (
    cursor.text[cursor.index] === "." &&
    DIGIT.test(cursor.text[cursor.index + 1] ?? "")
  ) {
    cursor.index += 1;
    digits += `.${scanWhile(cursor, DIGIT)}`;
  }

  return digits;
};

const quotedToken = (
  cursor: Cursor,
  start: number,
  delimiter: string
): Token => {
  const scanned = scanQuoted(cursor, delimiter);
  const span = { end: cursor.index, start };

  if (!scanned.ok) {
    return { kind: "error", span, text: scanned.message };
  }

  return {
    kind: delimiter === '"' ? "string" : "quotedName",
    span,
    text: scanned.value,
  };
};

const nextToken = (cursor: Cursor): Token => {
  scanWhile(cursor, SPACE);

  const start = cursor.index;
  const character = cursor.text[start] ?? "";

  if (start >= cursor.text.length) {
    return { kind: "end", span: { end: start, start }, text: "" };
  }

  if (character === '"' || character === "`") {
    cursor.index += 1;

    return quotedToken(cursor, start, character);
  }

  if (WORD_START.test(character)) {
    const text = scanWhile(cursor, WORD_PART);

    return { kind: "word", span: { end: cursor.index, start }, text };
  }

  if (DIGIT.test(character)) {
    const text = scanNumber(cursor);

    return { kind: "number", span: { end: cursor.index, start }, text };
  }

  const pair = cursor.text.slice(start, start + 2);
  const punctuation = TWO_CHARACTER.has(pair) ? pair : character;

  if (TWO_CHARACTER.has(punctuation) || ONE_CHARACTER.has(punctuation)) {
    cursor.index += punctuation.length;

    return {
      kind: "punctuation",
      span: { end: cursor.index, start },
      text: punctuation,
    };
  }

  cursor.index += String.fromCodePoint(
    cursor.text.codePointAt(start) ?? 0
  ).length;

  return {
    kind: "error",
    span: { end: cursor.index, start },
    text: "Unexpected character.",
  };
};

/**
 * Splits condition text into tokens, ending with an `end` token. Scanning
 * stops at the first `error` token.
 *
 * @param text - The condition text.
 * @returns The tokens.
 */
export const tokenize = (text: string): Token[] => {
  const cursor: Cursor = { index: 0, text };
  const tokens: Token[] = [];

  for (;;) {
    const token = nextToken(cursor);
    tokens.push(token);

    if (token.kind === "end" || token.kind === "error") {
      return tokens;
    }
  }
};
