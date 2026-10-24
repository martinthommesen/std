/**
 * Class-table DDL (Contracts 2.1, 2.4, 5.5): the statements that create and
 * extend STD tables. Every builder returns a `DdlStatement` of one form in
 * `ddl-forms.ts`; generated names come from stable IDs.
 *
 * A root table holds `id`, `class_id`, `version` and the audit columns; a
 * child level table holds `id` and `class_id`. Every table has
 * `PRIMARY KEY (id)`, `UNIQUE (id, class_id)`, the subtree CHECK and the
 * class-change trigger; every child table has the level FK, the only
 * `ON DELETE CASCADE` in an STD schema.
 */
import { rawSql, renderSql } from "@std/conditions/sql-fragment";
import type { FieldDefinition } from "@std/definitions/definition";
import { generatedName } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import {
  isCaseSensitive,
  maxLengthOf,
  postgresColumn,
} from "@std/values/field-type";

import { listOrderKey } from "../config/list-order-key.ts";
import type { DdlStatement, LockMode, TableLock } from "./ddl-forms.ts";
import { defaultLiteral, quoteIdent } from "./sql-text.ts";

const lock = (table: string, mode: LockMode): TableLock => ({ mode, table });

/** `ACCESS EXCLUSIVE`: what `ALTER TABLE` takes for every form STD generates except FKs. */
const ALTER = "ACCESS EXCLUSIVE";

/** `SHARE ROW EXCLUSIVE`: what adding a foreign key takes on both tables. */
const FOREIGN_KEY = "SHARE ROW EXCLUSIVE";

/** Columns of a root table before its fields. */
const ROOT_SYSTEM_COLUMNS = [
  "id uuid NOT NULL",
  "class_id uuid NOT NULL",
  "version bigint NOT NULL",
  "created_at timestamptz(3) NOT NULL",
  "created_by uuid NOT NULL",
  "updated_at timestamptz(3) NOT NULL",
  "updated_by uuid NOT NULL",
] as const;

/** Columns of a child level table before its fields. */
const LEVEL_SYSTEM_COLUMNS = [
  "id uuid NOT NULL",
  "class_id uuid NOT NULL",
] as const;

/**
 * A UUID literal.
 *
 * @param id - A definition ID.
 * @returns `'<id>'::uuid`.
 */
export const uuidLiteral = (id: DefinitionId): string => `'${id}'::uuid`;

/**
 * The subtree CHECK expression.
 *
 * @param subtreeIds - The class IDs of `subtree(T)`, sorted.
 * @returns `class_id IN ('...'::uuid, ...)`.
 */
export const subtreeExpression = (
  subtreeIds: readonly DefinitionId[]
): string => `class_id IN (${subtreeIds.map(uuidLiteral).join(", ")})`;

/**
 * Whether a field's column is `NOT NULL`: required fields and booleans.
 *
 * @param field - A field.
 * @returns True when the column carries the field's NOT NULL constraint.
 */
export const isNotNull = (field: FieldDefinition): boolean =>
  field.required || field.type.kind === "boolean";

const defaultClause = (field: FieldDefinition): string => {
  if (field.default !== null) {
    return ` DEFAULT ${defaultLiteral(field.type, field.default)}`;
  }

  return field.type.kind === "boolean" ? " DEFAULT false" : "";
};

/**
 * The column definition of a field: type, named NOT NULL, constant default.
 *
 * @param field - A field.
 * @returns For example `"name" text CONSTRAINT std_nn_... NOT NULL`.
 */
export const columnDefinition = (field: FieldDefinition): string => {
  const notNull = isNotNull(field)
    ? ` CONSTRAINT ${generatedName("nn", field.id)} NOT NULL`
    : "";

  return `${quoteIdent(field.name)} ${postgresColumn(field.type).sqlType}${notNull}${defaultClause(field)}`;
};

/**
 * The max-length CHECK expression of a text field.
 *
 * @param field - A text field.
 * @returns `char_length("col") <= n`, or undefined for other kinds.
 */
export const lengthCheck = (field: FieldDefinition): string | undefined =>
  field.type.kind === "text"
    ? `char_length(${quoteIdent(field.name)}) <= ${maxLengthOf(field.type)}`
    : undefined;

/** What a new class table needs. */
export interface NewTable {
  readonly classId: DefinitionId;
  /** Quoted `"namespace"."table"`. */
  readonly table: string;
  /** The parent's quoted table, for a child class. */
  readonly parentTable: string | null;
  readonly subtreeIds: readonly DefinitionId[];
  /** The fields this change set adds to the class, in order. */
  readonly fields: readonly FieldDefinition[];
}

/**
 * `CREATE SCHEMA` for a namespace.
 *
 * @param name - The namespace name.
 * @returns The statement.
 */
export const createSchema = (name: string): DdlStatement => ({
  form: "createSchema",
  locks: [],
  sql: `CREATE SCHEMA ${quoteIdent(name)}`,
});

/**
 * `CREATE TABLE` of a class table with the columns of its new fields
 * (Contracts 2.1).
 *
 * @param table - The new table.
 * @returns The statement.
 */
export const createTable = (table: NewTable): DdlStatement => {
  const system =
    table.parentTable === null ? ROOT_SYSTEM_COLUMNS : LEVEL_SYSTEM_COLUMNS;

  const checks = table.fields.flatMap((field) => {
    const check = lengthCheck(field);

    return check === undefined
      ? []
      : [`CONSTRAINT ${generatedName("ck", field.id)} CHECK (${check})`];
  });

  const level =
    table.parentTable === null
      ? []
      : [
          `CONSTRAINT ${generatedName("lv", table.classId)} FOREIGN KEY (id, class_id) REFERENCES ${table.parentTable} (id, class_id) ON DELETE CASCADE`,
        ];

  const body = [
    ...system,
    ...table.fields.map(columnDefinition),
    `CONSTRAINT ${generatedName("pk", table.classId)} PRIMARY KEY (id)`,
    `CONSTRAINT ${generatedName("uq", table.classId)} UNIQUE (id, class_id)`,
    `CONSTRAINT ${generatedName("sc", table.classId)} CHECK (${subtreeExpression(table.subtreeIds)})`,
    ...level,
    ...checks,
  ];

  return {
    form: "createTable",
    locks:
      table.parentTable === null ? [] : [lock(table.parentTable, FOREIGN_KEY)],
    sql: `CREATE TABLE ${table.table} (\n  ${body.join(",\n  ")}\n)`,
  };
};

/**
 * The class-change trigger of a table (Contracts 2.1): `WHEN` rather than
 * `UPDATE OF`, because column-specific triggers do not fire for changes made
 * by other BEFORE triggers.
 *
 * @param classId - The class.
 * @param table - Its quoted table.
 * @returns The statement.
 */
export const createTrigger = (
  classId: DefinitionId,
  table: string
): DdlStatement => ({
  form: "createTrigger",
  locks: [lock(table, ALTER)],
  sql: `CREATE TRIGGER ${generatedName("tg", classId)} BEFORE UPDATE ON ${table} FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
});

/**
 * Re-adds an ancestor's subtree CHECK for a widened subtree, `NOT VALID` and
 * never validated (Contracts 2.4): the old validated check implies the new
 * one, and the new one applies to new rows at once.
 *
 * @param classId - The ancestor.
 * @param table - Its quoted table.
 * @param subtreeIds - The widened subtree, sorted.
 * @returns The statement.
 */
export const replaceSubtreeCheck = (
  classId: DefinitionId,
  table: string,
  subtreeIds: readonly DefinitionId[]
): DdlStatement => {
  const name = generatedName("sc", classId);

  return {
    form: "replaceSubtreeCheck",
    locks: [lock(table, ALTER)],
    sql: `ALTER TABLE ${table} DROP CONSTRAINT ${name}, ADD CONSTRAINT ${name} CHECK (${subtreeExpression(subtreeIds)}) NOT VALID`,
  };
};

/**
 * `ADD COLUMN` of a field on an existing table: no default or a constant
 * one, so Postgres stores it in the catalog without a rewrite.
 *
 * @param table - The quoted table.
 * @param field - The field.
 * @returns The statement.
 */
export const addColumn = (
  table: string,
  field: FieldDefinition
): DdlStatement => ({
  form: "addColumn",
  locks: [lock(table, ALTER)],
  sql: `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(field)}`,
});

const notValid = (validated: boolean): string =>
  validated ? "" : " NOT VALID";

/**
 * A reference field's FK, `NO ACTION` (Contracts 3.10).
 *
 * @param table - The quoted table holding the column.
 * @param field - The reference field.
 * @param target - The quoted target table.
 * @param validated - False adds it `NOT VALID` (a table with rows).
 * @returns The statement.
 */
export const addReferenceKey = (
  table: string,
  field: FieldDefinition,
  target: string,
  validated: boolean
): DdlStatement => ({
  form: "addForeignKey",
  locks: [lock(table, FOREIGN_KEY), lock(target, FOREIGN_KEY)],
  sql: `ALTER TABLE ${table} ADD CONSTRAINT ${generatedName("fk", field.id)} FOREIGN KEY (${quoteIdent(field.name)}) REFERENCES ${target} (id)${notValid(validated)}`,
});

/**
 * The FK of a root table's audit column to `core.user`.
 *
 * @param classId - The root class.
 * @param table - Its quoted table.
 * @param column - `created_by` or `updated_by`.
 * @param userTable - The quoted `core.user` table.
 * @returns The statement.
 */
export const addAuditKey = (
  classId: DefinitionId,
  table: string,
  column: "created_by" | "updated_by",
  userTable: string
): DdlStatement => ({
  form: "addForeignKey",
  locks: [lock(table, FOREIGN_KEY), lock(userTable, FOREIGN_KEY)],
  sql: `ALTER TABLE ${table} ADD CONSTRAINT ${generatedName(column === "created_by" ? "cb" : "ub", classId)} FOREIGN KEY (${quoteIdent(column)}) REFERENCES ${userTable} (id)`,
});

/**
 * A text field's max-length CHECK.
 *
 * @param table - The quoted table.
 * @param field - The text field.
 * @param validated - False adds it `NOT VALID`.
 * @returns The statement, or undefined for other kinds.
 */
export const addLengthCheck = (
  table: string,
  field: FieldDefinition,
  validated: boolean
): DdlStatement | undefined => {
  const check = lengthCheck(field);

  return check === undefined
    ? undefined
    : {
        form: "addCheck",
        locks: [lock(table, ALTER)],
        sql: `ALTER TABLE ${table} ADD CONSTRAINT ${generatedName("ck", field.id)} CHECK (${check})${notValid(validated)}`,
      };
};

/**
 * Makes a field required with a named NOT NULL constraint (Postgres 18 can
 * add it `NOT VALID` and validate it later).
 *
 * @param table - The quoted table.
 * @param field - The field.
 * @param validated - False adds it `NOT VALID`.
 * @returns The statement.
 */
export const addNotNull = (
  table: string,
  field: FieldDefinition,
  validated: boolean
): DdlStatement => ({
  form: "addNotNull",
  locks: [lock(table, ALTER)],
  sql: `ALTER TABLE ${table} ADD CONSTRAINT ${generatedName("nn", field.id)} NOT NULL ${quoteIdent(field.name)}${notValid(validated)}`,
});

/**
 * Renames a namespace's schema. Tables, indexes and constraints keep their
 * OIDs and generated names; no table lock is involved (the rename locks
 * only the schema object, and STD statements name tables, not schemas).
 *
 * @param from - The current name.
 * @param to - The new name.
 * @returns The statement.
 */
export const renameSchema = (from: string, to: string): DdlStatement => ({
  form: "renameSchema",
  locks: [],
  sql: `ALTER SCHEMA ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`,
});

/**
 * Renames a table (Contracts 1.1); FKs referencing it follow by OID.
 *
 * @param table - The quoted table under its current name.
 * @param lockName - The quoted name the table has when locks are taken,
 *   before any DDL of the change set runs.
 * @param to - The new table name.
 * @returns The statement.
 */
export const renameTable = (
  table: string,
  lockName: string,
  to: string
): DdlStatement => ({
  form: "renameTable",
  locks: [lock(lockName, ALTER)],
  sql: `ALTER TABLE ${table} RENAME TO ${quoteIdent(to)}`,
});

/**
 * Renames a field's column (Contracts 1.1); index expressions and CHECKs
 * follow the column, and generated names never change.
 *
 * @param table - The quoted table under its current name.
 * @param lockName - The quoted name the table has when locks are taken.
 * @param from - The current column name.
 * @param to - The new column name.
 * @returns The statement.
 */
export const renameColumn = (
  table: string,
  lockName: string,
  from: string,
  to: string
): DdlStatement => ({
  form: "renameColumn",
  locks: [lock(lockName, ALTER)],
  sql: `ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`,
});

/**
 * Drops a retired required field's NOT NULL, catalog-only (Contracts 1.6),
 * so inserts without it work.
 *
 * @param table - The quoted table.
 * @param field - The field.
 * @returns The statement.
 */
export const dropNotNull = (
  table: string,
  field: FieldDefinition
): DdlStatement => ({
  form: "dropNotNull",
  locks: [lock(table, ALTER)],
  sql: `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(field.name)} DROP NOT NULL`,
});

/**
 * Drops a purged class's table. Its level FK and every FK it holds
 * (reference fields, audit columns) are dropped with it, which removes the
 * FK triggers on each referenced table, so all of them are locked
 * `ACCESS EXCLUSIVE`; ancestors come first, root first, as writers lock
 * them.
 *
 * @param table - The quoted table.
 * @param ancestors - The quoted ancestor tables, root first.
 * @param referenced - The quoted tables its FKs reference (parent excluded).
 * @returns The statement.
 */
export const dropTable = (
  table: string,
  ancestors: readonly string[],
  referenced: readonly string[]
): DdlStatement => {
  const own = new Set([table, ...ancestors]);

  return {
    form: "dropTable",
    locks: [
      ...ancestors.map((ancestor) => lock(ancestor, ALTER)),
      lock(table, ALTER),
      ...referenced.flatMap((target) =>
        own.has(target) ? [] : [lock(target, ALTER)]
      ),
    ],
    sql: `DROP TABLE ${table}`,
  };
};

/**
 * Drops a field's column (purge). Dropping a reference
 * column also drops its FK, which removes the FK triggers on the
 * referenced table, so both tables are locked `ACCESS EXCLUSIVE`.
 *
 * @param table - The quoted table.
 * @param field - The field.
 * @param referencedTable - The quoted target table of a reference field.
 * @returns The statement.
 */
export const dropColumn = (
  table: string,
  field: FieldDefinition,
  referencedTable: string | null
): DdlStatement => ({
  form: "dropColumn",
  locks:
    referencedTable === null
      ? [lock(table, ALTER)]
      : [lock(table, ALTER), lock(referencedTable, ALTER)],
  sql: `ALTER TABLE ${table} DROP COLUMN ${quoteIdent(field.name)}`,
});

/**
 * Drops a generated constraint (the abandon action of a `NOT VALID`
 * constraint). Dropping an FK removes its triggers on the referenced table
 * too, so both tables are locked `ACCESS EXCLUSIVE`.
 *
 * @param table - The quoted table.
 * @param constraint - The generated constraint name.
 * @param referencedTable - The quoted target table of an FK.
 * @returns The statement.
 */
export const dropConstraint = (
  table: string,
  constraint: string,
  referencedTable: string | null
): DdlStatement => ({
  form: "dropConstraint",
  locks:
    referencedTable === null
      ? [lock(table, ALTER)]
      : [lock(table, ALTER), lock(referencedTable, ALTER)],
  sql: `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`,
});

/**
 * Sets or drops a column default.
 *
 * @param table - The quoted table.
 * @param field - The field after the change.
 * @returns The statement.
 */
export const setDefault = (
  table: string,
  field: FieldDefinition
): DdlStatement => {
  const clause = defaultClause(field);

  return clause === ""
    ? {
        form: "dropDefault",
        locks: [lock(table, ALTER)],
        sql: `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(field.name)} DROP DEFAULT`,
      }
    : {
        form: "setDefault",
        locks: [lock(table, ALTER)],
        sql: `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(field.name)} SET${clause}`,
      };
};

/**
 * The index key of a field over a value expression: casefolded for
 * case-insensitive text, as is otherwise.
 *
 * @param field - An indexed field.
 * @param value - The column, or another expression of the field's value.
 * @returns The key expression.
 */
export const keyOf = (field: FieldDefinition, value: string): string =>
  field.type.kind === "text" && !isCaseSensitive(field.type)
    ? `casefold(${value} COLLATE pg_unicode_fast)`
    : value;

/**
 * The index key of a field: the casefold expression for case-insensitive
 * text (Contracts 5.5), the column otherwise.
 *
 * @param field - An indexed field.
 * @returns The key expression.
 */
export const indexKey = (field: FieldDefinition): string =>
  renderSql(listOrderKey(field.type, rawSql(quoteIdent(field.name)))).text;

/**
 * The value existing rows get in a column added for a field: its constant
 * default, `false` for booleans, NULL otherwise. Always a typed cast, never
 * a bare constant: the duplicate preflight puts it in `GROUP BY`, where
 * Postgres reads a bare integer as a column position and refuses any other
 * bare constant (42601).
 *
 * @param field - A field.
 * @returns A cast constant of the column's type, such as `'false'::boolean`.
 */
export const initialValue = (field: FieldDefinition): string => {
  const { sqlType } = postgresColumn(field.type);

  if (field.type.kind === "boolean") {
    return `'${field.default === true ? "true" : "false"}'::${sqlType}`;
  }

  return field.default === null
    ? `NULL::${sqlType}`
    : defaultLiteral(field.type, field.default);
};

/**
 * `CREATE [UNIQUE] INDEX`, plain or concurrent.
 *
 * @param indexId - The index definition.
 * @param table - The quoted table.
 * @param fields - The indexed fields, in order.
 * @param options - `unique`, and `concurrently` for a table with rows.
 * @returns The statement.
 */
export const createIndex = (
  indexId: DefinitionId,
  table: string,
  fields: readonly FieldDefinition[],
  options: { readonly unique: boolean; readonly concurrently: boolean }
): DdlStatement => {
  const unique = options.unique ? "UNIQUE " : "";
  const concurrently = options.concurrently ? "CONCURRENTLY " : "";

  return {
    form: options.concurrently ? "createIndexConcurrently" : "createIndex",
    locks: options.concurrently ? [] : [lock(table, "SHARE")],
    sql: `CREATE ${unique}INDEX ${concurrently}${generatedName("ix", indexId)} ON ${table} (${fields.map(indexKey).join(", ")})`,
  };
};

/**
 * `DROP INDEX CONCURRENTLY IF EXISTS`.
 *
 * @param indexId - The index definition.
 * @param schema - The namespace name.
 * @returns The statement.
 */
export const dropIndexConcurrently = (
  indexId: DefinitionId,
  schema: string
): DdlStatement => ({
  form: "dropIndexConcurrently",
  locks: [],
  sql: `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(schema)}.${generatedName("ix", indexId)}`,
});

/**
 * `VALIDATE CONSTRAINT` of a `NOT VALID` constraint.
 *
 * @param table - The quoted table.
 * @param constraint - The generated constraint name.
 * @returns The statement.
 */
export const validateConstraint = (
  table: string,
  constraint: string
): DdlStatement => ({
  form: "validateConstraint",
  locks: [],
  sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
});
