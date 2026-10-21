/**
 * Small helpers for building SQL text. Identifiers that come from definitions
 * are always quoted; every value is a bound parameter with a cast, as STD's
 * generated SQL does (architecture: "Generated SQL").
 */

/**
 * Quotes an identifier.
 *
 * @param name - A table, schema or column name.
 * @returns The quoted identifier.
 */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Quotes a name built from parts joined by `_`, such as an index name.
 *
 * @param parts - The name's parts.
 * @returns The quoted identifier.
 */
export const qn = (...parts: readonly string[]): string => q(parts.join("_"));

/**
 * A schema-qualified, quoted table name.
 *
 * @param schema - The schema.
 * @param name - The table.
 * @returns `"schema"."name"`.
 */
export const table = (schema: string, name: string): string =>
  `${q(schema)}.${q(name)}`;

/**
 * A UUID literal. Used only for class IDs, which are definition constants.
 *
 * @param id - A class's stable ID.
 * @returns `'<id>'::uuid`.
 */
export const uuidLiteral = (id: string): string => `'${id}'::uuid`;

/**
 * `IN (...)` over class IDs, or `=` for a single one.
 *
 * @param column - The `class_id` expression.
 * @param ids - Class IDs.
 * @returns The predicate.
 */
export const classIn = (column: string, ids: readonly string[]): string => {
  const [first] = ids;

  return ids.length === 1 && first !== undefined
    ? `${column} = ${uuidLiteral(first)}`
    : `${column} IN (${ids.map((id) => uuidLiteral(id)).join(", ")})`;
};

/** A compiled statement: SQL text and its parameters, all bound as text. */
export interface Compiled {
  readonly text: string;
  readonly params: readonly (string | null)[];
}

/** Collects bound parameters; equal values with equal casts share a placeholder. */
export interface Params {
  /** Binds a value and returns its placeholder with the cast, such as `$1::uuid`. */
  readonly bind: (value: string | null, cast: string) => string;
  readonly values: () => readonly (string | null)[];
}

/**
 * Creates an empty parameter list.
 *
 * @returns A parameter collector.
 */
export const makeParams = (): Params => {
  const values: (string | null)[] = [];
  const seen = new Map<string, string>();

  const bind = (value: string | null, cast: string): string => {
    const key = `${cast}\u0000${value ?? "\u0001null"}`;
    const existing = seen.get(key);

    if (existing !== undefined) {
      return existing;
    }

    values.push(value);
    const placeholder = `$${values.length}::${cast}`;
    seen.set(key, placeholder);

    return placeholder;
  };

  return { bind, values: () => [...values] };
};
