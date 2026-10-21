/**
 * What `pg_catalog` says about STD's schemas, read once per `doctor` run
 * inside its read-only transaction: tables, columns (dropped ones included,
 * for headroom) with their defaults, constraints with their structure,
 * indexes and triggers. Keys are `schema.table` with unquoted names.
 */
import { stringifyJson } from "@std/values/json";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";

/** A column of a table. */
export interface ColumnFact {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  /** `pg_get_expr` of the default, or null. */
  readonly default: string | null;
  readonly dropped: boolean;
}

/** A constraint of a table. */
export interface ConstraintFact {
  readonly name: string;
  /** `pg_constraint.contype`: `p`, `u`, `c`, `f`, `n`, ... */
  readonly type: string;
  readonly validated: boolean;
  readonly deferrable: boolean;
  readonly deferred: boolean;
  /** `confdeltype` of a foreign key (`a` is NO ACTION). */
  readonly deleteAction: string;
  /** `confupdtype` of a foreign key. */
  readonly updateAction: string;
  /** The constrained columns, in key order. */
  readonly columns: readonly string[];
  /** The referenced table of a foreign key (`schema.table`), or null. */
  readonly references: string | null;
  /** The referenced columns of a foreign key, in key order. */
  readonly referencedColumns: readonly string[];
  /** `pg_get_constraintdef`. */
  readonly definition: string;
}

/**
 * An index of a table, described structurally, so the description does
 * not depend on the session's `search_path` (which changes how Postgres
 * qualifies relation names in `pg_get_indexdef`).
 */
export interface IndexFact {
  readonly name: string;
  readonly valid: boolean;
  readonly unique: boolean;
  /** The access method, for example `btree`. */
  readonly method: string;
  /** Each key and included column or expression (`pg_get_indexdef(oid, k, true)`). */
  readonly keys: readonly string[];
  /** The partial index's predicate, or null. */
  readonly predicate: string | null;
}

/** A trigger of a table, described structurally. */
export interface TriggerFact {
  readonly name: string;
  /** The trigger function, `schema.name`. */
  readonly function: string;
  /** `pg_trigger.tgtype`: timing, level and events as bits. */
  readonly type: number;
  /** `pg_trigger.tgenabled`. */
  readonly enabled: string;
  /** The `WHEN` condition, or null. */
  readonly when: string | null;
}

/** One table and everything on it. */
export interface TableFacts {
  readonly columns: readonly ColumnFact[];
  readonly constraints: readonly ConstraintFact[];
  readonly indexes: readonly IndexFact[];
  readonly triggers: readonly TriggerFact[];
}

/** Every table of the schemas, by `schema.table`. */
export type CatalogFacts = ReadonlyMap<string, TableFacts>;

const Names = Schema.fromJsonString(Schema.Array(Schema.String));

const decodeTables = decodeRows(
  Schema.Struct({ schema: Schema.String, table: Schema.String })
);

const decodeColumns = decodeRows(
  Schema.Struct({
    default: Schema.NullOr(Schema.String),
    dropped: Schema.Boolean,
    name: Schema.String,
    not_null: Schema.Boolean,
    schema: Schema.String,
    table: Schema.String,
    type: Schema.String,
  })
);

const decodeConstraints = decodeRows(
  Schema.Struct({
    columns: Names,
    deferrable: Schema.Boolean,
    deferred: Schema.Boolean,
    definition: Schema.String,
    delete_action: Schema.String,
    name: Schema.String,
    ref_columns: Names,
    ref_schema: Schema.NullOr(Schema.String),
    ref_table: Schema.NullOr(Schema.String),
    schema: Schema.String,
    table: Schema.String,
    type: Schema.String,
    update_action: Schema.String,
    validated: Schema.Boolean,
  })
);

const decodeIndexes = decodeRows(
  Schema.Struct({
    keys: Names,
    method: Schema.String,
    name: Schema.String,
    predicate: Schema.NullOr(Schema.String),
    schema: Schema.String,
    table: Schema.String,
    unique: Schema.Boolean,
    valid: Schema.Boolean,
  })
);

const decodeTriggers = decodeRows(
  Schema.Struct({
    enabled: Schema.String,
    function: Schema.String,
    name: Schema.String,
    schema: Schema.String,
    table: Schema.String,
    type: Schema.Int,
    when: Schema.NullOr(Schema.String),
  })
);

/**
 * The key of a table.
 *
 * @param schema - The schema name.
 * @param table - The table name.
 * @returns `schema.table`.
 */
export const tableKey = (schema: string, table: string): string =>
  `${schema}.${table}`;

const group = <T extends { readonly schema: string; readonly table: string }>(
  rows: readonly T[]
): ReadonlyMap<string, readonly T[]> => {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const key = tableKey(row.schema, row.table);

    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return grouped;
};

const keyColumns = (keys: string, relation: string): string =>
  `coalesce((SELECT json_agg(a.attname ORDER BY k.ord)
     FROM unnest(${keys}) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = ${relation} AND a.attnum = k.attnum), '[]')::text`;

const IN_SCHEMAS = "n.nspname IN (SELECT jsonb_array_elements_text($1::jsonb))";

const TABLES_QUERY = `SELECT n.nspname AS schema, c.relname AS table
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND ${IN_SCHEMAS}`;

const COLUMNS_QUERY = `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
    format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_get_expr(d.adbin, d.adrelid) AS default, a.attisdropped AS dropped
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND ${IN_SCHEMAS}
  ORDER BY a.attnum`;

const CONSTRAINTS_QUERY = `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
    con.contype::text AS type, con.convalidated AS validated,
    con.condeferrable AS deferrable, con.condeferred AS deferred,
    con.confdeltype::text AS delete_action, con.confupdtype::text AS update_action,
    ${keyColumns("con.conkey", "con.conrelid")} AS columns,
    rn.nspname AS ref_schema, rc.relname AS ref_table,
    ${keyColumns("con.confkey", "con.confrelid")} AS ref_columns,
    pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class rc ON rc.oid = con.confrelid
  LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE ${IN_SCHEMAS}`;

const INDEXES_QUERY = `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
    x.indisvalid AS valid, x.indisunique AS unique, am.amname AS method,
    coalesce((SELECT json_agg(pg_get_indexdef(x.indexrelid, k, true) ORDER BY k)
      FROM generate_series(1, x.indnatts) AS k), '[]')::text AS keys,
    pg_get_expr(x.indpred, x.indrelid, true) AS predicate
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_am am ON am.oid = i.relam
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE ${IN_SCHEMAS}`;

const TRIGGERS_QUERY = `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
    fn.nspname || '.' || p.proname AS function, t.tgtype::int4 AS type, t.tgenabled::text AS enabled,
    substring(pg_get_triggerdef(t.oid, true) from 'WHEN \\((.*)\\) EXECUTE ') AS when
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace fn ON fn.oid = p.pronamespace
  WHERE NOT t.tgisinternal AND ${IN_SCHEMAS}`;

/**
 * Reads the catalog facts of some schemas.
 *
 * @param schemas - Schema names.
 * @returns Every ordinary table of them with its columns, constraints,
 *   indexes and triggers.
 */
export const readCatalogFacts = Effect.fn("Doctor.readCatalogFacts")(
  function* readCatalogFacts(
    schemas: readonly string[]
  ): Effect.fn.Return<CatalogFacts, SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const params = [stringifyJson(schemas)];
    const read = (text: string) => readOnly(sql.unsafe(text, params));

    const tables = yield* decodeTables(yield* read(TABLES_QUERY));
    const columns = group(yield* decodeColumns(yield* read(COLUMNS_QUERY)));

    const constraints = group(
      yield* decodeConstraints(yield* read(CONSTRAINTS_QUERY))
    );

    const indexes = group(yield* decodeIndexes(yield* read(INDEXES_QUERY)));
    const triggers = group(yield* decodeTriggers(yield* read(TRIGGERS_QUERY)));

    return new Map(
      tables.map((row) => {
        const key = tableKey(row.schema, row.table);

        const facts: TableFacts = {
          columns: (columns.get(key) ?? []).map((column) => ({
            default: column.default,
            dropped: column.dropped,
            name: column.name,
            notNull: column.not_null,
            type: column.type,
          })),
          constraints: (constraints.get(key) ?? []).map((entry) => ({
            columns: entry.columns,
            deferrable: entry.deferrable,
            deferred: entry.deferred,
            definition: entry.definition,
            deleteAction: entry.delete_action,
            name: entry.name,
            referencedColumns: entry.ref_columns,
            references:
              entry.ref_schema === null || entry.ref_table === null
                ? null
                : tableKey(entry.ref_schema, entry.ref_table),
            type: entry.type,
            updateAction: entry.update_action,
            validated: entry.validated,
          })),
          indexes: (indexes.get(key) ?? []).map((entry) => ({
            keys: entry.keys,
            method: entry.method,
            name: entry.name,
            predicate: entry.predicate,
            unique: entry.unique,
            valid: entry.valid,
          })),
          triggers: (triggers.get(key) ?? []).map((entry) => ({
            enabled: entry.enabled,
            function: entry.function,
            name: entry.name,
            type: entry.type,
            when: entry.when,
          })),
        };

        return [key, facts] as const;
      })
    );
  }
);
