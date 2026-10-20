/**
 * A small SQL fragment type: SQL text split around bound parameters, so
 * fragments from the condition compiler and from the server's record
 * compiler (masked column expressions, visibility guards) compose without
 * renumbering by hand. `renderSql` numbers the placeholders (`$1`, `$2`,
 * ...) and returns the parameter values in order, ready for the server's SQL
 * layer (`sql.unsafe(text, values)` in `@effect/sql-pg`).
 *
 * Every value is a bound text parameter with an explicit cast
 * (`$1::numeric`, `$2::text[]`), as Contracts 5.6 requires; nothing here
 * ever writes a value into the SQL text.
 */

/** A bound parameter: text, or an array of text, with its cast. */
export type SqlParameter =
  | { readonly kind: "text"; readonly value: string; readonly cast: string }
  | {
      readonly kind: "textArray";
      readonly values: readonly string[];
      readonly cast: string;
    };

/**
 * SQL text with parameters: `parts[i]` comes before `parameters[i]`, and
 * `parts` has exactly one more entry than `parameters`.
 */
export interface SqlFragment {
  readonly parts: readonly string[];
  readonly parameters: readonly SqlParameter[];
}

const CAST = /^[a-z][\d_a-z]*(?:\(\d+(?:,\d+)?\))?$/u;

/** An empty fragment. */
export const EMPTY_SQL: SqlFragment = { parameters: [], parts: [""] };

/**
 * Wraps trusted SQL text (keywords, operators, quoted identifiers).
 *
 * @param text - SQL text that holds no values.
 * @returns The fragment.
 */
export const rawSql = (text: string): SqlFragment => ({
  parameters: [],
  parts: [text],
});

/**
 * A text parameter with a cast.
 *
 * @param value - The parameter text.
 * @param cast - The Postgres type to cast to, such as `numeric`.
 * @returns The parameter.
 */
export const textParameter = (value: string, cast: string): SqlParameter => ({
  cast,
  kind: "text",
  value,
});

/**
 * An array parameter with an element cast (`$1::text[]`).
 *
 * @param values - The element texts.
 * @param cast - The element type, such as `uuid`.
 * @returns The parameter.
 */
export const arrayParameter = (
  values: readonly string[],
  cast: string
): SqlParameter => ({ cast, kind: "textArray", values });

const isFragment = (part: SqlFragment | SqlParameter): part is SqlFragment =>
  "parts" in part;

const append = (
  parts: string[],
  parameters: SqlParameter[],
  fragment: SqlFragment
): void => {
  const [first = "", ...rest] = fragment.parts;
  parts[parts.length - 1] = `${parts.at(-1) ?? ""}${first}`;
  parameters.push(...fragment.parameters);
  parts.push(...rest);
};

/**
 * Builds a fragment from a template: interpolations are fragments (spliced
 * in) or parameters (bound).
 *
 * @param strings - The template's SQL text.
 * @param values - Fragments and parameters.
 * @returns The fragment.
 */
export const sql = (
  strings: TemplateStringsArray,
  ...values: readonly (SqlFragment | SqlParameter)[]
): SqlFragment => {
  const parts: string[] = [strings[0] ?? ""];
  const parameters: SqlParameter[] = [];

  for (const [index, value] of values.entries()) {
    if (isFragment(value)) {
      append(parts, parameters, value);
    } else {
      parameters.push(value);
      parts.push("");
    }

    parts[parts.length - 1] =
      `${parts.at(-1) ?? ""}${strings[index + 1] ?? ""}`;
  }

  return { parameters, parts };
};

/**
 * Joins fragments with a separator.
 *
 * @param fragments - The fragments.
 * @param separator - Trusted SQL text between them.
 * @returns The joined fragment.
 */
export const joinSql = (
  fragments: readonly SqlFragment[],
  separator: string
): SqlFragment => {
  const parts: string[] = [""];
  const parameters: SqlParameter[] = [];

  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      append(parts, parameters, rawSql(separator));
    }

    append(parts, parameters, fragment);
  }

  return { parameters, parts };
};

/**
 * Quotes an identifier.
 *
 * @param name - A table, column or alias name from definitions.
 * @returns The double-quoted identifier.
 */
export const quoteIdent = (name: string): string => {
  if (name.length === 0 || name.includes("\0")) {
    throw new Error("An SQL identifier must be non-empty and hold no NUL.");
  }

  return `"${name.replaceAll('"', '""')}"`;
};

/**
 * A quoted, optionally qualified identifier as a fragment.
 *
 * @param names - Qualifiers then the name, such as `["r", "status"]`.
 * @returns `"r"."status"`.
 */
export const identSql = (...names: readonly string[]): SqlFragment =>
  rawSql(names.map((name) => quoteIdent(name)).join("."));

/** SQL text with numbered placeholders and the values to bind. */
export interface RenderedSql {
  readonly text: string;
  readonly values: readonly (string | readonly string[])[];
}

/**
 * Numbers the placeholders and lists the values.
 *
 * @param fragment - The fragment.
 * @param firstPlaceholder - The number of the first placeholder, when the
 *   fragment goes into a statement that already binds parameters.
 * @returns `{ text, values }`; placeholder `$n` binds `values[n - first]`.
 */
export const renderSql = (
  fragment: SqlFragment,
  firstPlaceholder = 1
): RenderedSql => {
  let text = fragment.parts[0] ?? "";
  const values: (string | readonly string[])[] = [];

  for (const [index, parameter] of fragment.parameters.entries()) {
    if (!CAST.test(parameter.cast)) {
      throw new Error("A parameter cast must be a plain type name.");
    }

    const suffix = parameter.kind === "textArray" ? "[]" : "";
    text += `$${firstPlaceholder + index}::${parameter.cast}${suffix}`;
    text += fragment.parts[index + 1] ?? "";
    values.push(parameter.kind === "text" ? parameter.value : parameter.values);
  }

  return { text, values };
};
