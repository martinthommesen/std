/**
 * The conditions a measurement ran under: hardware, Node, Postgres version
 * and settings, and the machine's concurrent load (other agents run tests
 * against the same Postgres server on this machine).
 */
import { cpus, loadavg, release, totalmem, type as osType } from "node:os";

import { decodeRows } from "@std/server/sql/rows";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** Postgres settings recorded with every result. */
export const RECORDED_SETTINGS = [
  "server_version",
  "shared_buffers",
  "max_connections",
  "work_mem",
  "maintenance_work_mem",
  "synchronous_commit",
  "fsync",
  "wal_sync_method",
  "wal_level",
  "max_wal_size",
  "checkpoint_timeout",
  "effective_io_concurrency",
  "client_connection_check_interval",
  "deadlock_timeout",
  "lock_timeout",
  "statement_timeout",
  "default_transaction_isolation",
  "autovacuum",
  "data_checksums",
  "huge_pages",
  "jit",
] as const;

/** Host and server facts, recorded once per measurement run. */
export interface Environment {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly os: string;
  readonly node: string;
  readonly postgresVersion: string;
  readonly settings: Readonly<Record<string, string>>;
}

/** Concurrent load, sampled before and after each probe. */
export interface Conditions {
  /** `os.loadavg()`: 1, 5 and 15 minute load averages. */
  readonly loadAverage: readonly number[];
  /** Client sessions connected to other databases of the server. */
  readonly otherSessions: number;
  /** Of those, sessions running a statement. */
  readonly otherActive: number;
  /** Test databases that exist (other agents' test runs). */
  readonly testDatabases: number;
}

const BYTES_PER_GIB = 1024 ** 3;

const decodeSettings = decodeRows(
  Schema.Struct({ name: Schema.String, setting: Schema.String })
);

const decodeVersion = decodeRows(Schema.Struct({ version: Schema.String }));

const decodeActivity = decodeRows(
  Schema.Struct({
    other_active: Schema.Int,
    other_sessions: Schema.Int,
    test_databases: Schema.Int,
  })
);

/**
 * Reads the host and Postgres facts.
 * @returns The environment.
 */
export const readEnvironment = Effect.gen(function* environment() {
  const sql = yield* SqlClient.SqlClient;

  const [version] = yield* sql`SELECT version() AS version`.pipe(
    Effect.flatMap(decodeVersion)
  );

  const rows = yield* sql`
    SELECT name, setting || coalesce(' ' || nullif(unit, ''), '') AS setting
    FROM pg_settings WHERE name IN ${sql.in([...RECORDED_SETTINGS])}`.pipe(
    Effect.flatMap(decodeSettings)
  );

  const [firstCpu] = cpus();

  const facts: Environment = {
    cores: cpus().length,
    cpu: firstCpu?.model ?? "unknown",
    memoryGiB: Math.round(totalmem() / BYTES_PER_GIB),
    node: process.version,
    os: `${osType()} ${release()}`,
    postgresVersion: version?.version ?? "",
    settings: Object.fromEntries(rows.map((row) => [row.name, row.setting])),
  };

  return facts;
});

/**
 * Samples the machine's concurrent load.
 * @returns Load averages and other sessions on the Postgres server.
 */
export const readConditions = Effect.gen(function* conditions() {
  const sql = yield* SqlClient.SqlClient;

  const [activity] = yield* sql`
    SELECT count(*) FILTER (WHERE datname IS DISTINCT FROM current_database())::int AS other_sessions,
           count(*) FILTER (WHERE datname IS DISTINCT FROM current_database() AND state = 'active')::int AS other_active,
           (SELECT count(*)::int FROM pg_database WHERE datname LIKE 'std\\_test\\_%') AS test_databases
    FROM pg_stat_activity WHERE backend_type = 'client backend'`.pipe(
    Effect.flatMap(decodeActivity)
  );

  const sampled: Conditions = {
    loadAverage: loadavg(),
    otherActive: activity?.other_active ?? 0,
    otherSessions: activity?.other_sessions ?? 0,
    testDatabases: activity?.test_databases ?? 0,
  };

  return sampled;
});
