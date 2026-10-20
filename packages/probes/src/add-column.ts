/**
 * Probe 5 (plan 0F; Contracts 1.4 "Add field", 6.5 boolean): adding a
 * column to a populated table inside a config commit.
 *
 * For each case a fresh table gets `rows` rows, then one config commit runs
 * `ALTER TABLE ... ADD COLUMN <column>` and bumps the revision. The probe
 * compares `relfilenode` (a rewrite gives the table a new file) and
 * `pg_stat_user_tables.seq_scan` (a verification scan counts as one) before
 * and after, and times the statement. The volatile default is the contrast
 * case: it rewrites the table, which shows the probe detects a rewrite.
 *
 * Autovacuum is disabled on the probe tables so it cannot hold a lock the
 * `ALTER TABLE` would wait for.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { readTableState } from "./catalog-state.ts";
import { timedMillis } from "./clock.ts";

/** One `ADD COLUMN` form. */
export interface AddColumnCase {
  /** A short label for reports. */
  readonly label: string;
  /** The column definition after `ADD COLUMN`. */
  readonly column: string;
  /** Whether Postgres is expected to change only the catalog. */
  readonly catalogOnly: boolean;
}

/** The cases of probe 5, in report order. */
export const ADD_COLUMN_CASES: readonly AddColumnCase[] = [
  {
    catalogOnly: true,
    column: "flag boolean NOT NULL DEFAULT false",
    label: "boolean NOT NULL DEFAULT false",
  },
  {
    catalogOnly: true,
    column: "note text DEFAULT 'none'",
    label: "nullable text with a constant default",
  },
  {
    catalogOnly: false,
    column: "noise double precision DEFAULT random()",
    label: "volatile default (contrast case)",
  },
];

/** What one case measured. */
export interface AddColumnCaseResult {
  readonly label: string;
  readonly statement: string;
  readonly rows: number;
  /** Client-side time of the `ALTER TABLE` statement. */
  readonly statementMs: number;
  /** Time of the whole config commit (lock, DDL, revision bump, commit). */
  readonly commitMs: number;
  readonly relfilenodeBefore: string;
  readonly relfilenodeAfter: string;
  readonly seqScanBefore: number;
  readonly seqScanAfter: number;
  readonly expectedCatalogOnly: boolean;
}

/** Result of probe 5. */
export interface AddColumnProbeResult {
  readonly rows: number;
  readonly cases: readonly AddColumnCaseResult[];
}

/** Options of probe 5. */
export interface AddColumnProbeOptions {
  /** Rows in each probe table (the contract names 1,000,000). */
  readonly rows: number;
  /** The cases to run (default: all). */
  readonly cases?: readonly AddColumnCase[];
}

/**
 * Runs probe 5 on the current database.
 * @param options - Table size and cases.
 * @returns One result per case.
 */
export const runAddColumnProbe = Effect.fn("runAddColumnProbe")(
  function* addColumnProbe(options: AddColumnProbeOptions) {
    const connection = yield* makeDedicatedConnection({
      applicationName: "std-probe-add-column",
    });

    const results: AddColumnCaseResult[] = [];

    for (const [index, probeCase] of (
      options.cases ?? ADD_COLUMN_CASES
    ).entries()) {
      const table = `probe_add_column_${index}`;
      yield* connection.execute(`DROP TABLE IF EXISTS ${table}`);
      yield* connection.execute(
        `CREATE TABLE ${table} (id bigint PRIMARY KEY, name text NOT NULL)
         WITH (autovacuum_enabled = false)`
      );
      yield* connection.execute(
        `INSERT INTO ${table} (id, name)
         SELECT g, 'row ' || g FROM generate_series(1, $1::int8) AS g`,
        [String(options.rows)]
      );

      const before = yield* readTableState(connection.execute, table);
      const statement = `ALTER TABLE ${table} ADD COLUMN ${probeCase.column}`;

      const [commitMs, statementMs] = yield* timedMillis(
        connection.transactions.configCommit(
          Effect.gen(function* addColumn() {
            const sql = yield* SqlClient.SqlClient;
            const [elapsed] = yield* timedMillis(sql.unsafe(statement));
            yield* bumpRevision(randomUUID());

            return elapsed;
          })
        )
      );

      const after = yield* readTableState(connection.execute, table);
      yield* connection.execute(`DROP TABLE ${table}`);

      results.push({
        commitMs,
        expectedCatalogOnly: probeCase.catalogOnly,
        label: probeCase.label,
        relfilenodeAfter: after.relfilenode,
        relfilenodeBefore: before.relfilenode,
        rows: options.rows,
        seqScanAfter: after.seqScan,
        seqScanBefore: before.seqScan,
        statement,
        statementMs,
      });
    }

    const result: AddColumnProbeResult = { cases: results, rows: options.rows };

    return result;
  }
);
