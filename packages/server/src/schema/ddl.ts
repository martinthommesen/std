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
import type { FieldDefinition } from "@std/definitions/definition";
import { generatedName } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import {
  isCaseSensitive,
  maxLengthOf,
  postgresColumn,
} from "@std/values/field-type";

import type { DdlStatement } from "./ddl-forms.ts";
import { defaultLiteral, quoteIdent } from "./sql-text.ts";

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
  sql: `ALTER TABLE ${table} ADD CONSTRAINT ${generatedName("nn", field.id)} NOT NULL ${quoteIdent(field.name)}${notValid(validated)}`,
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
        sql: `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(field.name)} DROP DEFAULT`,
      }
    : {
        form: "setDefault",
        sql: `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(field.name)} SET${clause}`,
      };
};

/**
 * The index key of a field: the casefold expression for case-insensitive
 * text (Contracts 5.5), the column otherwise.
 *
 * @param field - An indexed field.
 * @returns The key expression.
 */
export const indexKey = (field: FieldDefinition): string =>
  field.type.kind === "text" && !isCaseSensitive(field.type)
    ? `casefold(${quoteIdent(field.name)} COLLATE pg_unicode_fast)`
    : quoteIdent(field.name);

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
  sql: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
});
