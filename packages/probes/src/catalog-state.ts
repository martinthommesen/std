/**
 * Catalog and statistics readings the probes compare before and after a
 * statement: a table's `relfilenode` (changes when the table is rewritten)
 * and its `pg_stat_user_tables.seq_scan` counter (grows with every
 * sequential scan).
 *
 * Statistics are reported to shared memory with a delay, so every reading
 * first runs `pg_stat_force_next_flush()` on the connection that did the
 * work. The flush happens when that backend next goes idle, which is before
 * it answers the statement, so the next statement reads flushed counters.
 */
import type { DatabaseError } from "@std/server/sql/errors";
import { decodeRows } from "@std/server/sql/rows";
import { Effect, Schema } from "effect";

/** Runs one autocommit statement, as `DedicatedConnection.execute` does. */
export type Execute = (
  sql: string,
  params?: readonly unknown[]
) => Effect.Effect<readonly unknown[], DatabaseError>;

/** What the probes compare for one table. */
export interface TableState {
  /** The file node: a rewrite gives the table a new one. */
  readonly relfilenode: string;
  /** Sequential scans started on the table since statistics were reset. */
  readonly seqScan: number;
  /** Index scans started on the table's indexes. */
  readonly idxScan: number;
}

const decodeState = decodeRows(
  Schema.Struct({
    idx_scan: Schema.Finite,
    relfilenode: Schema.String,
    seq_scan: Schema.Finite,
  })
);

const STATE_QUERY = `
SELECT c.relfilenode::text AS relfilenode,
       coalesce(s.seq_scan, 0)::float8 AS seq_scan,
       coalesce(s.idx_scan, 0)::float8 AS idx_scan
FROM pg_class c
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.oid = $1::regclass`;

/**
 * Flushes the backend's pending statistics. Call it on the connection that
 * ran the work before reading counters, on any connection.
 * @param execute - Runs a statement on the connection that did the work.
 * @returns Completes once the flush has happened.
 */
export const flushStatistics = (
  execute: Execute
): Effect.Effect<void, DatabaseError> =>
  Effect.asVoid(execute("SELECT pg_stat_force_next_flush()"));

/**
 * Reads a table's file node and scan counters, after flushing the
 * statistics of the connection.
 * @param execute - Runs a statement on the connection that did the work.
 * @param table - A table name, schema-qualified if needed.
 * @returns The table's state.
 */
export const readTableState = Effect.fn("readTableState")(function* readState(
  execute: Execute,
  table: string
) {
  yield* flushStatistics(execute);

  const [row] = yield* execute(STATE_QUERY, [table]).pipe(
    Effect.flatMap(decodeState)
  );

  if (row === undefined) {
    return yield* Effect.die(new Error(`table ${table} not found`));
  }

  const state: TableState = {
    idxScan: row.idx_scan,
    relfilenode: row.relfilenode,
    seqScan: row.seq_scan,
  };

  return state;
});
