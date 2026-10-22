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

const UNDERSCORES = /_+/u;

/**
 * The API name of a field in `/api/v2` (Contracts 10.2; TMF630 v5.0.0
 * Part 1 §2.5 pp.22-23): its definition name split at runs of underscores,
 * the parts after the first capitalized and joined, so `short_description`
 * becomes `shortDescription`, `due__date` `dueDate` and `foo_` `foo`.
 * Every valid identifier gets one lowerCamelCase name; clashes are checked
 * on these names. Definition names stay snake case, so plain SQL stays
 * readable (1.1).
 *
 * @param name - A definition or system field name.
 * @returns The lowerCamelCase name.
 */
export const apiNameOf = (name: string): string =>
  name
    .split(UNDERSCORES)
    .filter((part) => part !== "")
    .map((part, index) =>
      index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    )
    .join("");

const upperFirst = (name: string): string =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * The `/api/v2` collection name of a table (Contracts 10.1; TMF630 v5.0.0
 * Part 1 §2.5 p.22, Martin 2026-10-22): its namespace and table names in
 * lowerCamelCase, joined with the table's first letter upper case, so
 * `helpdesk.ticket_note` is `helpdeskTicketNote`. The inverse is a lookup
 * over the snapshot's tables, never a parse of the name.
 *
 * @param namespace - The namespace name.
 * @param table - The table name.
 * @returns The collection name.
 */
export const apiTableNameOf = (namespace: string, table: string): string =>
  `${apiNameOf(namespace)}${upperFirst(apiNameOf(table))}`;

/**
 * The `/api/v2` type name of a table (`@type`, `@baseType`,
 * `@referredType`): its collection name in UpperCamelCase, so
 * `helpdesk.incident` is `HelpdeskIncident`.
 *
 * @param namespace - The namespace name.
 * @param table - The table name.
 * @returns The type name.
 */
export const apiTypeNameOf = (namespace: string, table: string): string =>
  upperFirst(apiTableNameOf(namespace, table));

/**
 * The fixed resources of `/api/v2` (Contracts 10.1). No table's collection
 * name may equal one of them: definition validation refuses it
 * (`apiNameClash`), so a path segment names a fixed resource or a table,
 * never both.
 */
export const FIXED_RESOURCE_NAMES: ReadonlySet<string> = new Set([
  "session",
  "tableMetadata",
  "hub",
  "listener",
  "checkFormState",
  "applyChangeSet",
  "openapi",
]);

/**
 * The `/api/v2` names of the system fields (Contracts 10.2; TMF630 v5.0.0
 * Part 7 §2.1.3 p.18 and Part 4 §3 pp.28-33): `version` is the record's
 * `revision`, because TMF's `version` names an entity version;
 * `created_at` is `creationDate` and `updated_at` `lastUpdate`. `class`
 * has none: it is `@type`.
 */
export const SYSTEM_API_NAMES = {
  created_at: "creationDate",
  created_by: "createdBy",
  id: "id",
  updated_at: "lastUpdate",
  updated_by: "updatedBy",
  version: "revision",
} as const satisfies Readonly<Record<string, string>>;

const SYSTEM_API_NAME_MAP: ReadonlyMap<string, string> = new Map(
  Object.entries(SYSTEM_API_NAMES)
);

/**
 * v2 names of shipped platform fields whose definition names are reserved
 * API names: `core.field`'s `type` is `fieldType`, because TMF630 v5.0.0
 * Part 7 §2.1.3 p.18 reserves `type`. A local or app field can never take
 * such a name (`apiNameClash`), so the rename applies to the core field
 * only.
 */
const PLATFORM_API_NAMES: ReadonlyMap<string, string> = new Map([
  ["type", "fieldType"],
]);

/**
 * The `/api/v2` name of a field or system field: `SYSTEM_API_NAMES` for
 * system fields, `apiNameOf` for every other (definition names never take
 * a system field's name, Contracts 1.1).
 *
 * @param name - The field's name.
 * @returns Its attribute name.
 */
export const apiAttributeNameOf = (name: string): string =>
  SYSTEM_API_NAME_MAP.get(name) ??
  PLATFORM_API_NAMES.get(name) ??
  apiNameOf(name);

/**
 * Attribute names of a `/api/v2` resource that no field's API name may
 * take (Contracts 10.2): the system attributes, `href`, `version` (TMF's
 * entity version) and STD's `withheld`. Anything starting with `@` is
 * reserved as well ({@link isReservedApiName}).
 */
export const RESERVED_API_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(SYSTEM_API_NAMES),
  "href",
  "type",
  "version",
  "withheld",
]);

/**
 * Whether an API name is reserved (Contracts 10.2).
 *
 * @param apiName - A field's API name.
 * @returns True for a system attribute, `withheld` or an `@` name.
 */
export const isReservedApiName = (apiName: string): boolean =>
  RESERVED_API_NAMES.has(apiName) || apiName.startsWith("@");

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
