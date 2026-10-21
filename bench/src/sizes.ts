/**
 * Table and index sizes of a model's schema (Contracts 2.6 "table plus index
 * size"). Partitions are listed individually; staging tables are excluded.
 */
import type { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { BenchError } from "./errors.ts";
import { query } from "./execute.ts";

/** The size of one table. */
export interface TableSize {
  readonly table: string;
  readonly rows: number;
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly totalBytes: number;
  readonly indexes: number;
}

const SizeRow = Schema.Struct({
  index_bytes: Schema.String,
  indexes: Schema.String,
  rows: Schema.String,
  table_bytes: Schema.String,
  table_name: Schema.String,
  total_bytes: Schema.String,
});

const sizeQuery =
  "SELECT c.relname::text AS table_name, c.reltuples::bigint::text AS rows, " +
  "pg_table_size(c.oid)::text AS table_bytes, pg_indexes_size(c.oid)::text AS index_bytes, " +
  "pg_total_relation_size(c.oid)::text AS total_bytes, " +
  "(SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)::text AS indexes " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1::text AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC";

/**
 * Sizes of every table in a schema, largest first.
 *
 * @param schema - The model's schema.
 * @returns One entry per table.
 */
export const schemaSizes = (
  schema: string
): Effect.Effect<readonly TableSize[], SqlError | BenchError, PgClient> =>
  Effect.map(query({ params: [schema], text: sizeQuery }, SizeRow), (rows) =>
    rows.map((row) => ({
      indexBytes: Number(row.index_bytes),
      indexes: Number(row.indexes),
      rows: Number(row.rows),
      table: `${schema}.${row.table_name}`,
      tableBytes: Number(row.table_bytes),
      totalBytes: Number(row.total_bytes),
    }))
  );
