/**
 * A small lexer for the shape of a SQL text: how many statements it holds
 * and the leading words of the first one.
 *
 * It follows Postgres's lexical rules closely enough that nothing can hide a
 * statement's first keyword or a statement separator: whitespace, `--` line
 * comments, nested `/* *\/` block comments, string constants (`'...'` with
 * `''`, escape strings `E'...'` with backslashes), quoted identifiers
 * (`"..."` with `""`), Unicode escapes (`U&'...'`, `U&"..."`), dollar-quoted
 * strings (`$tag$...$tag$`), positional parameters (`$1`), numeric
 * literals and punctuation. Line comments end at CR, LF or CRLF.
 * Unterminated constructs consume the rest of the text, as Postgres would
 * before rejecting it.
 *
 * String continuation follows Postgres's scanner (`scan.l`, the `xqs` state
 * and `quotecontinue`): after a string constant, whitespace holding at least
 * one newline and then `'` continues the same constant in the same mode, so
 * `E'a'` + newline + `'\'x'` is one escape string. Line comments (`--`) may
 * sit in that whitespace; a block comment ends the constant. Dollar-quoted
 * strings do not continue. Numeric literals are one token, so the `.` of
 * `1.` is not mistaken for a qualifying `.`; a literal followed directly by
 * letters is a lexical error in Postgres, and the lexer keeps those letters
 * in the same token.
 */

/** The shape of a SQL text. */
export interface LexedStatement {
  /**
   * The leading names of the first statement, lower-cased: unquoted words
   * and the contents of quoted identifiers, up to the first other token, at
   * most `MAX_LEADING_WORDS`.
   */
  readonly leadingWords: readonly string[];
  /**
   * The first `MAX_LEADING_TOKENS` tokens of the text (comments and
   * whitespace skipped, separators excluded), with their kinds.
   */
  readonly leadingTokens: readonly LexedToken[];
  /** How many non-empty statements the text holds, separated by top-level `;`. */
  readonly statements: number;
  /** How many top-level `;` the text holds. */
  readonly separators: number;
  /**
   * Whether the statement holds a clause that writes although it may start
   * like a query (whether it does is the caller's check): an unquoted `INTO`
   * anywhere except as a name right after `AS` or a qualifying `.` (a
   * fully reserved word, so otherwise only `SELECT INTO`, `INSERT INTO` or
   * `MERGE INTO`), or a `WITH` whose top-level entries' bodies or primary
   * statement do not start with `SELECT`, `VALUES`, `TABLE`, `WITH` or `(`
   * (Postgres accepts data-modifying statements only there). A `WITH` that
   * does not parse is counted as writing.
   */
  readonly writeClause: boolean;
}

/** The kinds of token the classifier sees; see `LexedToken.kind`. */
export type LexedTokenKind = "word" | "quoted" | "literal" | "other";

/** One token as the classifier sees it. */
export interface LexedToken {
  /**
   * `word`: an unquoted word, lower-cased. `quoted`: a quoted identifier
   * (`"..."` or `U&"..."`), its contents lower-cased. `literal`: a string
   * constant. `other`: anything else, as written.
   */
  readonly kind: LexedTokenKind;
  readonly text: string;
}

/** How many leading words the lexer reports. */
export const MAX_LEADING_WORDS = 4;

/** How many leading tokens the lexer reports. */
export const MAX_LEADING_TOKENS = 6;

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
 * The end of a line comment: just after the first CR or LF, or the text's end.
 * @param sql - The text.
 * @param start - Offset of the `--`.
 * @returns The offset after the line terminator.
 */
const lineEnd = (sql: string, start: number): number => {
  let index = start;

  while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
    index += 1;
  }

  return Math.min(index + 1, sql.length);
};

const isNewline = (code: number): boolean =>
  code === LINE_FEED || code === CARRIAGE_RETURN;

/**
 * Where the next segment of a continued string constant starts, following
 * `quotecontinue` in Postgres's scanner: blanks, newlines and line comments
 * (each ended by a newline), at least one newline among them, then `'`.
 * @param sql - The text.
 * @param end - Offset just after a string constant's closing quote.
 * @returns The offset of the continuing `'`, or `undefined` when the constant ends.
 */
const continuationAt = (sql: string, end: number): number | undefined => {
  let index = end;
  let sawNewline = false;

  for (;;) {
    const code = codeAt(sql, index);

    if (sql.startsWith("--", index)) {
      index = lineEnd(sql, index);

      if (!isNewline(codeAt(sql, index - 1))) {
        return undefined;
      }

      sawNewline = true;
    } else if (isBlank(code)) {
      sawNewline ||= isNewline(code);
      index += 1;
    } else {
      return sawNewline && sql[index] === "'" ? index : undefined;
    }
  }
};

/**
 * The end of a string constant starting at `start` (on its opening `'`),
 * with every continuation segment, all in the first segment's mode.
 * @param sql - The text.
 * @param start - Offset of the opening quote.
 * @param backslashEscapes - Whether `\` escapes the next character (`E'...'`).
 * @returns The offset just after the last segment, or the text's length.
 */
const stringEnd = (
  sql: string,
  start: number,
  backslashEscapes: boolean
): number => {
  let end = quotedEnd(sql, start, "'", backslashEscapes);
  let next = continuationAt(sql, end);

  while (next !== undefined) {
    end = quotedEnd(sql, next, "'", backslashEscapes);
    next = continuationAt(sql, end);
  }

  return end;
};

/**
 * A numeric literal starting at `start` (a digit, or `.` before a digit):
 * word characters (digits, `_` separators, `0x`/`0o`/`0b` prefixes,
 * exponents, trailing junk) and each `.` not followed by another `.`.
 * Erring towards a longer token only makes a following `INTO` count as a
 * clause.
 * @param sql - The text.
 * @param start - Offset of the literal.
 * @returns The token.
 */
const numberToken = (sql: string, start: number): Token => {
  let index = start;

  for (;;) {
    const code = codeAt(sql, index);
    const isDot = sql[index] === "." && sql[index + 1] !== ".";

    if (!isWordPart(code) && !isDot) {
      return { end: index, kind: "other" };
    }

    index += 1;
  }
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
    return { end: stringEnd(sql, index, true), kind: "literal" };
  }

  const unicodeQuote = sql[index + 1];

  if ((word === "u" || word === "U") && sql[index] === "&") {
    if (unicodeQuote === "'") {
      return { end: stringEnd(sql, index + 1, false), kind: "literal" };
    }

    if (unicodeQuote === '"') {
      const end = quotedEnd(sql, index + 1, '"', false);

      return {
        end,
        kind: "quoted",
        name: sql.slice(index + 2, end - 1).toLowerCase(),
      };
    }
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
    return { end: lineEnd(sql, start), kind: "blank" };
  }

  if (sql.startsWith("/*", start)) {
    return { end: blockCommentEnd(sql, start), kind: "blank" };
  }

  if (char === ";") {
    return { end: start + 1, kind: "separator" };
  }

  if (char === "'") {
    return { end: stringEnd(sql, start, false), kind: "literal" };
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

  if (isDigit(code) || (char === "." && isDigit(codeAt(sql, start + 1)))) {
    return numberToken(sql, start);
  }

  return { end: start + 1, kind: "other" };
};

/** Words that start a query: what a `WITH` entry's body or primary statement may start with. */
const QUERY_STARTS = new Set(["select", "table", "values", "with"]);

/** Marks a parse of a `WITH` that failed; the statement counts as writing. */
const UNPARSED = -1;

const isWord = (token: LexedToken | undefined, word: string): boolean =>
  token?.kind === "word" && token.text === word;

const isPunctuation = (token: LexedToken | undefined, char: string): boolean =>
  token?.kind === "other" && token.text === char;

const isNameToken = (token: LexedToken | undefined): boolean =>
  token?.kind === "word" || token?.kind === "quoted";

const startsQuery = (token: LexedToken | undefined): boolean =>
  (token?.kind === "word" && QUERY_STARTS.has(token.text)) ||
  isPunctuation(token, "(");

/**
 * The position just after the parenthesis that closes the one at `open`.
 * @param tokens - The statement's tokens.
 * @param open - Position of a `(`.
 * @returns The position, or `UNPARSED` when it is not closed.
 */
const afterParentheses = (
  tokens: readonly LexedToken[],
  open: number
): number => {
  let depth = 0;

  for (let index = open; index < tokens.length; index += 1) {
    if (isPunctuation(tokens[index], "(")) {
      depth += 1;
    } else if (isPunctuation(tokens[index], ")")) {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return UNPARSED;
};

/**
 * The position after a list of names separated by commas.
 * @param tokens - The statement's tokens.
 * @param start - Position of the first name.
 * @returns The position, or `UNPARSED`.
 */
const afterNames = (tokens: readonly LexedToken[], start: number): number => {
  if (!isNameToken(tokens[start])) {
    return UNPARSED;
  }

  let index = start + 1;

  while (isPunctuation(tokens[index], ",")) {
    if (!isNameToken(tokens[index + 1])) {
      return UNPARSED;
    }

    index += 2;
  }

  return index;
};

/**
 * The position after an optional search clause:
 * `SEARCH BREADTH FIRST BY names SET name` or the same with `DEPTH`.
 * @param tokens - The statement's tokens.
 * @param start - Where the clause would start.
 * @returns The position, `start` without the clause, or `UNPARSED`.
 */
const afterSearch = (tokens: readonly LexedToken[], start: number): number => {
  if (!isWord(tokens[start], "search")) {
    return start;
  }

  const order = tokens[start + 1];
  const ordered = isWord(order, "breadth") || isWord(order, "depth");

  if (
    !ordered ||
    !isWord(tokens[start + 2], "first") ||
    !isWord(tokens[start + 3], "by")
  ) {
    return UNPARSED;
  }

  const names = afterNames(tokens, start + 4);

  return names !== UNPARSED &&
    isWord(tokens[names], "set") &&
    isNameToken(tokens[names + 1])
    ? names + 2
    : UNPARSED;
};

/**
 * The position after an optional cycle clause:
 * `CYCLE names SET name [TO value DEFAULT value] USING name`.
 * `USING` is fully reserved, so the clause ends at the first unquoted
 * `USING` outside parentheses.
 * @param tokens - The statement's tokens.
 * @param start - Where the clause would start.
 * @returns The position, `start` without the clause, or `UNPARSED`.
 */
const afterCycle = (tokens: readonly LexedToken[], start: number): number => {
  if (!isWord(tokens[start], "cycle")) {
    return start;
  }

  let index = start + 1;

  while (index < tokens.length && !isWord(tokens[index], "using")) {
    index = isPunctuation(tokens[index], "(")
      ? afterParentheses(tokens, index)
      : index + 1;

    if (index === UNPARSED) {
      return UNPARSED;
    }
  }

  return isNameToken(tokens[index + 1]) ? index + 2 : UNPARSED;
};

/**
 * The position after one `WITH` entry, whose body must start like a query:
 * `name [(names)] AS [[NOT] MATERIALIZED] (body) [SEARCH ...] [CYCLE ...]`.
 * @param tokens - The statement's tokens.
 * @param start - Position of the entry's name.
 * @returns The position, or `UNPARSED` (also for a body that is no query).
 */
const afterWithEntry = (
  tokens: readonly LexedToken[],
  start: number
): number => {
  if (!isNameToken(tokens[start])) {
    return UNPARSED;
  }

  let index = start + 1;

  if (isPunctuation(tokens[index], "(")) {
    index = afterParentheses(tokens, index);
  }

  if (!isWord(tokens[index], "as")) {
    return UNPARSED;
  }

  index += 1;

  if (isWord(tokens[index], "not")) {
    index += 1;

    if (!isWord(tokens[index], "materialized")) {
      return UNPARSED;
    }
  }

  if (isWord(tokens[index], "materialized")) {
    index += 1;
  }

  if (!isPunctuation(tokens[index], "(") || !startsQuery(tokens[index + 1])) {
    return UNPARSED;
  }

  const body = afterParentheses(tokens, index);
  const search = body === UNPARSED ? UNPARSED : afterSearch(tokens, body);

  return search === UNPARSED ? UNPARSED : afterCycle(tokens, search);
};

/**
 * Whether a statement starting with `WITH` may write: an entry's body or
 * the primary statement does not start like a query, or the list does not
 * parse. Postgres refuses data-modifying statements in a nested `WITH`, so
 * only the top-level list is read.
 * @param tokens - The statement's tokens, `WITH` first.
 * @returns `true` unless every top-level body and the primary statement start like a query.
 */
const withWrites = (tokens: readonly LexedToken[]): boolean => {
  let index = isWord(tokens[1], "recursive") ? 2 : 1;

  for (;;) {
    index = afterWithEntry(tokens, index);

    if (index === UNPARSED) {
      return true;
    }

    if (!isPunctuation(tokens[index], ",")) {
      return !startsQuery(tokens[index]);
    }

    index += 1;
  }
};

/**
 * See `LexedStatement.writeClause`.
 * @param tokens - The text's tokens, comments and whitespace skipped.
 * @returns Whether the text holds a clause that writes.
 */
const hasWriteClause = (tokens: readonly LexedToken[]): boolean =>
  tokens.some(
    (token, index) =>
      isWord(token, "into") &&
      !isWord(tokens[index - 1], "as") &&
      !isPunctuation(tokens[index - 1], ".")
  ) ||
  (isWord(tokens[0], "with") && withWrites(tokens));

/**
 * Lexes a SQL text into its shape.
 * @param sql - The text sent to the driver.
 * @returns How many statements it holds and the first statement's leading words.
 */
export const analyzeStatement = (sql: string): LexedStatement => {
  const leadingWords: string[] = [];
  const leadingTokens: LexedToken[] = [];
  let collecting = true;
  let statements = 0;
  let separators = 0;
  let inStatement = false;
  const tokens: LexedToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const start = index;
    const token = tokenAt(sql, index);
    index = token.end;

    if (token.kind === "separator") {
      separators += 1;

      if (inStatement) {
        statements += 1;
        inStatement = false;
      }

      collecting = false;
    } else if (token.kind !== "blank") {
      const lexed: LexedToken = {
        kind: token.kind,
        text: token.name ?? sql.slice(start, token.end),
      };

      tokens.push(lexed);

      if (leadingTokens.length < MAX_LEADING_TOKENS) {
        leadingTokens.push(lexed);
      }

      inStatement = true;

      const isName = token.kind === "word" || token.kind === "quoted";

      if (collecting && isName && token.name !== undefined) {
        leadingWords.push(token.name);
      }

      collecting &&= isName && leadingWords.length < MAX_LEADING_WORDS;
    }
  }

  return {
    leadingTokens,
    leadingWords,
    separators,
    statements: inStatement ? statements + 1 : statements,
    writeClause: hasWriteClause(tokens),
  };
};
