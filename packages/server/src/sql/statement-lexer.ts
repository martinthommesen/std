/**
 * A small lexer for the shape of a SQL text: how many statements it holds
 * and the leading words of the first one.
 *
 * It follows Postgres's lexical rules closely enough that nothing can hide a
 * statement's first keyword or a statement separator: whitespace, `--` line
 * comments, nested `/* *\/` block comments, string constants (`'...'` with
 * `''`, escape strings `E'...'` with backslashes), quoted identifiers
 * (`"..."` with `""`), dollar-quoted strings (`$tag$...$tag$`), positional
 * parameters (`$1`) and punctuation. Unterminated constructs consume the
 * rest of the text, as Postgres would before rejecting it.
 */

/** The shape of a SQL text. */
export interface LexedStatement {
  /**
   * The leading names of the first statement, lower-cased: unquoted words
   * and the contents of quoted identifiers, up to the first other token, at
   * most `MAX_LEADING_WORDS`.
   */
  readonly leadingWords: readonly string[];
  /** How many non-empty statements the text holds, separated by top-level `;`. */
  readonly statements: number;
}

/** How many leading words the lexer reports. */
export const MAX_LEADING_WORDS = 4;

type TokenKind =
  | "blank"
  | "word"
  | "quoted"
  | "literal"
  | "separator"
  | "other";

/** One token: its kind, where it ends, and its text for names. */
interface Token {
  readonly kind: TokenKind;
  readonly end: number;
  readonly name?: string;
}

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const VERTICAL_TAB = 0x0b;
const FORM_FEED = 0x0c;
const CARRIAGE_RETURN = 0x0d;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const UNDERSCORE = 0x5f;
const DOLLAR = 0x24;
const FIRST_NON_ASCII = 0x80;

const BLANKS = new Set([
  SPACE,
  TAB,
  LINE_FEED,
  VERTICAL_TAB,
  FORM_FEED,
  CARRIAGE_RETURN,
]);

const isBlank = (code: number): boolean => BLANKS.has(code);

/**
 * The code point at an offset, or `-1` past the end.
 * @param sql - The text.
 * @param index - The offset.
 * @returns The code point.
 */
const codeAt = (sql: string, index: number): number =>
  sql.codePointAt(index) ?? -1;

const isDigit = (code: number): boolean =>
  code >= DIGIT_ZERO && code <= DIGIT_NINE;

const isAsciiLetter = (code: number): boolean =>
  (code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z);

const isWordStart = (code: number): boolean =>
  isAsciiLetter(code) || code === UNDERSCORE || code >= FIRST_NON_ASCII;

const isTagPart = (code: number): boolean => isWordStart(code) || isDigit(code);

const isWordPart = (code: number): boolean =>
  isTagPart(code) || code === DOLLAR;

/**
 * The end of a quoted run that starts at `start` (on the opening quote),
 * where a doubled quote stands for itself.
 * @param sql - The text.
 * @param start - Offset of the opening quote.
 * @param quote - `'` or `"`.
 * @param backslashEscapes - Whether `\` escapes the next character (`E'...'`).
 * @returns The offset just after the closing quote, or the text's length.
 */
const quotedEnd = (
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean
): number => {
  let index = start + 1;

  while (index < sql.length) {
    const char = sql[index];

    if (backslashEscapes && char === "\\") {
      index += 2;
    } else if (char === quote && sql[index + 1] === quote) {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }

  return sql.length;
};

/**
 * The end of a nested block comment starting at `start` (on `/*`).
 * @param sql - The text.
 * @param start - Offset of the comment.
 * @returns The offset just after the comment, or the text's length.
 */
const blockCommentEnd = (sql: string, start: number): number => {
  let depth = 0;
  let index = start;

  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;

      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }

  return sql.length;
};

/**
 * A token starting with `$`: a positional parameter, a dollar-quoted
 * string, or a lone `$`.
 * @param sql - The text.
 * @param start - Offset of the `$`.
 * @returns The token.
 */
const dollarToken = (sql: string, start: number): Token => {
  let index = start + 1;

  if (isDigit(codeAt(sql, index))) {
    while (isDigit(codeAt(sql, index))) {
      index += 1;
    }

    return { end: index, kind: "other" };
  }

  if (isWordStart(codeAt(sql, index))) {
    while (isTagPart(codeAt(sql, index))) {
      index += 1;
    }
  }

  if (codeAt(sql, index) !== DOLLAR) {
    return { end: start + 1, kind: "other" };
  }

  const tag = sql.slice(start, index + 1);
  const close = sql.indexOf(tag, index + 1);

  return {
    end: close === -1 ? sql.length : close + tag.length,
    kind: "literal",
  };
};

/**
 * A word, or an escape string when the word is a lone `E` before `'`.
 * @param sql - The text.
 * @param start - Offset of the word.
 * @returns The token.
 */
const wordToken = (sql: string, start: number): Token => {
  let index = start + 1;

  while (isWordPart(codeAt(sql, index))) {
    index += 1;
  }

  const word = sql.slice(start, index);

  if ((word === "e" || word === "E") && sql[index] === "'") {
    return { end: quotedEnd(sql, index, "'", true), kind: "literal" };
  }

  return { end: index, kind: "word", name: word.toLowerCase() };
};

/**
 * The token starting at `start`.
 * @param sql - The text.
 * @param start - Where the token starts.
 * @returns The token.
 */
const tokenAt = (sql: string, start: number): Token => {
  const code = codeAt(sql, start);
  const char = sql[start];

  if (isBlank(code)) {
    return { end: start + 1, kind: "blank" };
  }

  if (sql.startsWith("--", start)) {
    const newline = sql.indexOf("\n", start);

    return { end: newline === -1 ? sql.length : newline + 1, kind: "blank" };
  }

  if (sql.startsWith("/*", start)) {
    return { end: blockCommentEnd(sql, start), kind: "blank" };
  }

  if (char === ";") {
    return { end: start + 1, kind: "separator" };
  }

  if (char === "'") {
    return { end: quotedEnd(sql, start, "'", false), kind: "literal" };
  }

  if (char === '"') {
    const end = quotedEnd(sql, start, '"', false);
    const name = sql.slice(start + 1, end - 1).replaceAll('""', '"');

    return { end, kind: "quoted", name: name.toLowerCase() };
  }

  if (code === DOLLAR) {
    return dollarToken(sql, start);
  }

  if (isWordStart(code)) {
    return wordToken(sql, start);
  }

  return { end: start + 1, kind: "other" };
};

/**
 * Lexes a SQL text into its shape.
 * @param sql - The text sent to the driver.
 * @returns How many statements it holds and the first statement's leading words.
 */
export const analyzeStatement = (sql: string): LexedStatement => {
  const leadingWords: string[] = [];
  let collecting = true;
  let statements = 0;
  let inStatement = false;
  let index = 0;

  while (index < sql.length) {
    const token = tokenAt(sql, index);
    index = token.end;

    if (token.kind === "separator") {
      if (inStatement) {
        statements += 1;
        inStatement = false;
      }

      collecting = false;
    } else if (token.kind !== "blank") {
      inStatement = true;

      const isName = token.kind === "word" || token.kind === "quoted";

      if (collecting && isName && token.name !== undefined) {
        leadingWords.push(token.name);
      }

      collecting &&= isName && leadingWords.length < MAX_LEADING_WORDS;
    }
  }

  return {
    leadingWords,
    statements: inStatement ? statements + 1 : statements,
  };
};
