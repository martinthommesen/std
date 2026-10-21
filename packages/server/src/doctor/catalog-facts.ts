/**
 * What `pg_catalog` says about STD's schemas, read once per `doctor` run:
 * tables, columns (dropped ones included, for headroom), constraints,
 * indexes and triggers. Keys are `schema.table` with unquoted names.
 */
import { stringifyJson } from "@std/values/json";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";

/** A column of a table. */
export interface ColumnFact {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly dropped: boolean;
}

/** A constraint of a table. */
export interface ConstraintFact {
  readonly name: string;
  /** `pg_constraint.contype`: `p`, `u`, `c`, `f`, `n`, ... */
  readonly type: string;
  readonly validated: boolean;
  /** `confdeltype` of a foreign key (`a` is NO ACTION). */
  readonly deleteAction: string;
  /** `confupdtype` of a foreign key. */
  readonly updateAction: string;
}

/** An index of a table. */
export interface IndexFact {
  readonly name: string;
  readonly valid: boolean;
}

/** One table and everything on it. */
export interface TableFacts {
  readonly columns: readonly ColumnFact[];
  readonly constraints: readonly ConstraintFact[];
  readonly indexes: readonly IndexFact[];
  readonly triggers: readonly string[];
}

/** Every table of the schemas, by `schema.table`. */
export type CatalogFacts = ReadonlyMap<string, TableFacts>;

const decodeTables = decodeRows(
  Schema.Struct({ schema: Schema.String, table: Schema.String })
);

const decodeColumns = decodeRows(
  Schema.Struct({
    dropped: Schema.Boolean,
    has_default: Schema.Boolean,
    name: Schema.String,
    not_null: Schema.Boolean,
    schema: Schema.String,
    table: Schema.String,
    type: Schema.String,
  })
);

const decodeConstraints = decodeRows(
  Schema.Struct({
    delete_action: Schema.String,
    name: Schema.String,
    schema: Schema.String,
    table: Schema.String,
    type: Schema.String,
    update_action: Schema.String,
    validated: Schema.Boolean,
  })
);

const decodeIndexes = decodeRows(
  Schema.Struct({
    name: Schema.String,
    schema: Schema.String,
    table: Schema.String,
    valid: Schema.Boolean,
  })
);

const decodeTriggers = decodeRows(
  Schema.Struct({
    name: Schema.String,
    schema: Schema.String,
    table: Schema.String,
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
    const names = stringifyJson(schemas);

    const tables = yield* sql`
      SELECT n.nspname AS schema, c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname IN (SELECT jsonb_array_elements_text(${names}::jsonb))`.pipe(
      Effect.flatMap(decodeTables)
    );

    const columns = yield* sql`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
             a.atthasdef AS has_default, a.attisdropped AS dropped
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND a.attnum > 0
        AND n.nspname IN (SELECT jsonb_array_elements_text(${names}::jsonb))
      ORDER BY a.attnum`.pipe(Effect.flatMap(decodeColumns));

    const constraints = yield* sql`
      SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
             con.contype::text AS type, con.convalidated AS validated,
             con.confdeltype::text AS delete_action, con.confupdtype::text AS update_action
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (SELECT jsonb_array_elements_text(${names}::jsonb))`.pipe(
      Effect.flatMap(decodeConstraints)
    );

    const indexes = yield* sql`
      SELECT n.nspname AS schema, t.relname AS table, i.relname AS name, x.indisvalid AS valid
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname IN (SELECT jsonb_array_elements_text(${names}::jsonb))`.pipe(
      Effect.flatMap(decodeIndexes)
    );

    const triggers = yield* sql`
      SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND n.nspname IN (SELECT jsonb_array_elements_text(${names}::jsonb))`.pipe(
      Effect.flatMap(decodeTriggers)
    );

    const byTable = {
      columns: group(columns),
      constraints: group(constraints),
      indexes: group(indexes),
      triggers: group(triggers),
    };

    return new Map(
      tables.map((row) => {
        const key = tableKey(row.schema, row.table);

        return [
          key,
          {
            columns: (byTable.columns.get(key) ?? []).map((column) => ({
              dropped: column.dropped,
              hasDefault: column.has_default,
              name: column.name,
              notNull: column.not_null,
              type: column.type,
            })),
            constraints: (byTable.constraints.get(key) ?? []).map((entry) => ({
              deleteAction: entry.delete_action,
              name: entry.name,
              type: entry.type,
              updateAction: entry.update_action,
              validated: entry.validated,
            })),
            indexes: (byTable.indexes.get(key) ?? []).map((entry) => ({
              name: entry.name,
              valid: entry.valid,
            })),
            triggers: (byTable.triggers.get(key) ?? []).map(
              (entry) => entry.name
            ),
          },
        ] as const;
      })
    );
  }
);
