/** SQL tokens for the conservative migration-phase check, not a SQL AST. */
export interface SqlToken {
  readonly text: string;
  readonly literal: boolean;
  readonly body?: string;
}

const identifier = /[a-z_][a-z_\d]*/iuy;
const numeric = /\d+(?:\.\d+)?/uy;
const dollarTag = /\$[a-z_\d]*\$/iuy;

const quotedEnd = (sql: string, start: number, quote: string): number => {
  let position = start + 1;

  while (position < sql.length) {
    if (sql[position] === quote) {
      if (sql[position + 1] !== quote) {
        return position + 1;
      }

      position += 1;
    }

    position += 1;
  }

  throw new Error("Unterminated SQL quoted value");
};

const commentEnd = (sql: string, start: number): number => {
  let depth = 1;
  let position = start + 2;

  while (position < sql.length && depth > 0) {
    const pair = sql.slice(position, position + 2);

    if (pair === "/*") {
      depth += 1;
      position += 2;
    } else if (pair === "*/") {
      depth -= 1;
      position += 2;
    } else {
      position += 1;
    }
  }

  if (depth > 0) {
    throw new Error("Unterminated SQL comment");
  }

  return position;
};

interface Scan {
  readonly end: number;
  readonly token: SqlToken | null;
}

const scan = (sql: string, start: number): Scan => {
  const character = sql.charAt(start);

  if (character.trim() === "") {
    return { end: start + 1, token: null };
  }

  if (sql.startsWith("--", start)) {
    const newline = sql.indexOf("\n", start);

    return { end: newline === -1 ? sql.length : newline + 1, token: null };
  }

  if (sql.startsWith("/*", start)) {
    return { end: commentEnd(sql, start), token: null };
  }

  if (character === "'" || character === '"') {
    const end = quotedEnd(sql, start, character);

    return {
      end,
      token: { literal: character === "'", text: sql.slice(start, end) },
    };
  }

  dollarTag.lastIndex = start;
  const tag = dollarTag.exec(sql)?.[0];

  if (tag !== undefined) {
    const close = sql.indexOf(tag, start + tag.length);

    if (close === -1) {
      throw new Error("Unterminated SQL dollar body");
    }

    return {
      end: close + tag.length,
      token: {
        body: sql.slice(start + tag.length, close),
        literal: true,
        text: "<body>",
      },
    };
  }

  for (const pattern of [identifier, numeric]) {
    pattern.lastIndex = start;
    const match = pattern.exec(sql)?.[0];

    if (match !== undefined) {
      return {
        end: start + match.length,
        token: { literal: false, text: match.toUpperCase() },
      };
    }
  }

  const text = sql.startsWith("::", start) ? "::" : character;

  return { end: start + text.length, token: { literal: false, text } };
};

/**
 * Separates comments, literal bodies and identifiers before checking SQL.
 * @param sql - Evaluated SQL text.
 * @returns The tokens, excluding comments and whitespace.
 */
export const migrationSqlTokens = (sql: string): readonly SqlToken[] => {
  const tokens: SqlToken[] = [];
  let position = 0;

  while (position < sql.length) {
    const next = scan(sql, position);
    position = next.end;

    if (next.token !== null) {
      tokens.push(next.token);
    }
  }

  return tokens;
};

/**
 * Splits only outside parentheses and quoted literals.
 * @param tokens - Tokens of a statement or statement list.
 * @param separator - Semicolon for statements, comma for ALTER actions.
 * @returns Nonempty parts.
 */
export const splitSqlTokens = (
  tokens: readonly SqlToken[],
  separator: string
): readonly SqlToken[][] => {
  const parts: SqlToken[][] = [[]];
  let depth = 0;

  for (const token of tokens) {
    if (!token.literal && token.text === "(") {
      depth += 1;
    }

    if (!token.literal && token.text === ")") {
      depth -= 1;
    }

    if (token.text === separator && depth === 0 && !token.literal) {
      parts.push([]);
    } else {
      parts.at(-1)?.push(token);
    }

    if (depth < 0) {
      throw new Error("Unbalanced SQL parentheses");
    }
  }

  if (depth !== 0) {
    throw new Error("Unbalanced SQL parentheses");
  }

  return parts.filter((part) => part.length > 0);
};
