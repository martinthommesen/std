/**
 * Text pattern operators (Contracts 5.4, 5.9): `contains`, `startsWith` and
 * `endsWith` compare keys, so the SQL is `k(f) LIKE $1` with a pattern built
 * here: fold the needle unless the field is case-sensitive, escape `\`, `%`
 * and `_` with the default escape character `\`, and add `%`.
 */
import { textKey } from "./fold.ts";

/** A text pattern operator. */
export type PatternOperator = "contains" | "startsWith" | "endsWith";

const LIKE_SPECIAL = /[%\\_]/gu;

/**
 * Escapes text for a Postgres `LIKE` pattern with the default escape `\`.
 *
 * @param text - Literal text.
 * @returns The text with `\`, `%` and `_` preceded by `\`.
 */
export const escapeLike = (text: string): string =>
  text.replaceAll(LIKE_SPECIAL, String.raw`\$&`);

/**
 * Builds the `LIKE` pattern for a pattern operator.
 *
 * @param operator - `contains`, `startsWith` or `endsWith`.
 * @param needle - The needle after `convertNeedle` (steps 1 and 2).
 * @param caseSensitive - The field's `caseSensitive` setting.
 * @returns The pattern to bind as `$1` in `k(f) LIKE $1`.
 */
export const likePattern = (
  operator: PatternOperator,
  needle: string,
  caseSensitive: boolean
): string => {
  const escaped = escapeLike(textKey(needle, caseSensitive));

  switch (operator) {
    case "contains": {
      return `%${escaped}%`;
    }

    case "startsWith": {
      return `${escaped}%`;
    }

    case "endsWith": {
      return `%${escaped}`;
    }

    default: {
      return operator satisfies never;
    }
  }
};

/**
 * Evaluates a pattern operator in TypeScript, matching the SQL form.
 *
 * @param operator - `contains`, `startsWith` or `endsWith`.
 * @param value - The stored text (non-null).
 * @param needle - The needle after `convertNeedle`.
 * @param caseSensitive - The field's `caseSensitive` setting.
 * @returns True when key(needle) is a substring, prefix or suffix of
 *   key(value).
 */
export const matchesPattern = (
  operator: PatternOperator,
  value: string,
  needle: string,
  caseSensitive: boolean
): boolean => {
  const haystack = textKey(value, caseSensitive);
  const key = textKey(needle, caseSensitive);

  switch (operator) {
    case "contains": {
      return haystack.includes(key);
    }

    case "startsWith": {
      return haystack.startsWith(key);
    }

    case "endsWith": {
      return haystack.endsWith(key);
    }

    default: {
      return operator satisfies never;
    }
  }
};
