/**
 * Name rules for definitions (Contracts 1.1, 1.8).
 *
 * Namespace, table and field names become Postgres identifiers (schemas,
 * tables, columns), quoted in generated SQL. They are lowercase ASCII
 * snake case: a letter, then letters, digits and underscores, at most 63
 * bytes (Postgres truncates longer identifiers silently [checked:
 * https://www.postgresql.org/docs/18/limits.html]). Role names follow the
 * same rule; permission names are dotted (`schema.purge`).
 */

/** Postgres's identifier limit in bytes (`NAMEDATALEN - 1`). */
export const IDENTIFIER_MAX_BYTES = 63;

const IDENTIFIER = /^[a-z][\da-z_]*$/u;

const DOTTED_NAME = /^[a-z][\da-z_]*(?:\.[a-z][\da-z_]*)+$/u;

/**
 * Field names every class has as system fields or physical columns. `class`
 * is the API name of the concrete class, `class_id` its column.
 */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set([
  "id",
  "class",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

/**
 * Namespace names that are never available: Postgres's own schemas and the
 * `pg_` and `std_` prefixes.
 */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "public",
  "information_schema",
]);

/** Prefixes refused for namespaces and tables (Postgres's and generated names). */
const RESERVED_PREFIXES = ["pg_", "std_"] as const;

/** Why a name is refused. */
export type NameProblem =
  | "empty"
  | "tooLong"
  | "invalidCharacters"
  | "reserved"
  | "reservedPrefix";

/**
 * Checks an identifier-like name (namespace, table, field, role).
 *
 * @param name - The proposed name.
 * @returns The problem, or undefined when the name is valid.
 */
export const identifierProblem = (name: string): NameProblem | undefined => {
  if (name.length === 0) {
    return "empty";
  }

  if (!IDENTIFIER.test(name)) {
    return "invalidCharacters";
  }

  // The pattern is ASCII only, so characters are bytes.
  return name.length > IDENTIFIER_MAX_BYTES ? "tooLong" : undefined;
};

/**
 * Checks a field name: an identifier that is not a system field name.
 *
 * @param name - The proposed field name.
 * @returns The problem, or undefined.
 */
export const fieldNameProblem = (name: string): NameProblem | undefined =>
  identifierProblem(name) ??
  (RESERVED_FIELD_NAMES.has(name) ? "reserved" : undefined);

const reservedPrefix = (name: string): boolean =>
  RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * Checks a table name: an identifier without a `pg_` or `std_` prefix, so a
 * table never collides with a generated index name in its schema.
 *
 * @param name - The proposed table name.
 * @returns The problem, or undefined.
 */
export const tableNameProblem = (name: string): NameProblem | undefined =>
  identifierProblem(name) ??
  (reservedPrefix(name) ? "reservedPrefix" : undefined);

/**
 * Checks a namespace name: an identifier that Postgres accepts as a new
 * schema name.
 *
 * @param name - The proposed namespace name.
 * @returns The problem, or undefined.
 */
export const namespaceNameProblem = (name: string): NameProblem | undefined => {
  const problem = tableNameProblem(name);

  if (problem !== undefined) {
    return problem;
  }

  return RESERVED_NAMESPACES.has(name) ? "reserved" : undefined;
};

/**
 * Checks a permission name: dotted identifiers such as `schema.purge`.
 *
 * @param name - The proposed permission name.
 * @returns The problem, or undefined.
 */
export const permissionNameProblem = (
  name: string
): NameProblem | undefined => {
  if (name.length === 0) {
    return "empty";
  }

  if (!DOTTED_NAME.test(name)) {
    return "invalidCharacters";
  }

  return name.length > IDENTIFIER_MAX_BYTES ? "tooLong" : undefined;
};

/**
 * The qualified name of a table, as used in API paths and set files.
 *
 * @param namespace - The namespace name.
 * @param table - The table name.
 * @returns `namespace.table`.
 */
export const qualifiedName = (namespace: string, table: string): string =>
  `${namespace}.${table}`;

/**
 * Splits a qualified table name.
 *
 * @param name - `namespace.table`.
 * @returns Both parts, or undefined when the name has no single dot.
 */
export const splitQualifiedName = (
  name: string
): { readonly namespace: string; readonly table: string } | undefined => {
  const parts = name.split(".");

  if (parts.length !== 2) {
    return undefined;
  }

  const [namespace, table] = parts;

  return namespace === undefined || table === undefined
    ? undefined
    : { namespace, table };
};
