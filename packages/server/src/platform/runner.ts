/**
 * The platform migration runner (Contracts 1.9, 8.5).
 *
 * - `checkPlatformMigrations` is the server's startup check: it refuses to
 *   start when a migration is pending, when a `data` migration's row is
 *   still `running` (an interrupted `std upgrade`), when the ledger holds
 *   one the code does not know, or when an applied checksum differs.
 * - `runPlatformMigrations` is the migration step of `std upgrade` for
 *   `tx` and `concurrent_index` migrations (`data` migrations run after the
 *   sets load, `data-migrations.ts`). It
 *   refuses on a non-UTF8 database and while a `std-server` session is
 *   connected to the database, takes `SCHEMA_KEY` with
 *   `pg_try_advisory_lock` on a dedicated connection, and applies the
 *   pending migrations in order. A rerun after a crash continues from the
 *   last recorded migration.
 */
import type { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import { UPGRADE_BLOCKING_APPLICATION_PREFIXES } from "../sql/database-config.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import { makeDedicatedConnection } from "../sql/dedicated.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { decodeRows } from "../sql/rows.ts";
import { STD_VERSION } from "../version.ts";
import {
  compareLedger,
  installedSetVersions,
  readLedger,
  refusalOf,
  LEDGER_COLUMNS,
  decodeLedgerColumns,
} from "./ledger.ts";
import type { MigrationStateRefused } from "./ledger.ts";
import { isSchemaMigration, migrationChecksum } from "./migration.ts";
import type {
  ConcurrentIndexMigration,
  PlatformMigration,
  SchemaMigration,
  TxMigration,
} from "./migration.ts";
import { PLATFORM_MIGRATIONS } from "./migrations.ts";

/** `lock_timeout` of `tx` migrations (Contracts 1.4). */
export const MIGRATION_LOCK_TIMEOUT = "2s";

/** `statement_timeout` of `tx` migrations (Contracts 1.4). */
export const MIGRATION_STATEMENT_TIMEOUT = "15s";

/** Refusal reason: the database encoding is not UTF8. */
const ENCODING_REFUSAL = "encoding";

/** Refusal reason: a `std-server` session is connected to the database. */
const SERVERS_REFUSAL = "servers-connected";

/** Refusal reason: another session holds `SCHEMA_KEY` (a change set or another upgrade). */
const SCHEMA_BUSY_REFUSAL = "schema-busy";

/** Why `std upgrade` cannot run now. */
export const UpgradeRefusal = Schema.Literals([
  ENCODING_REFUSAL,
  SERVERS_REFUSAL,
  SCHEMA_BUSY_REFUSAL,
]);

/** The services the migration step needs. */
export type UpgradeServices =
  | DatabaseConfig
  | PgClient.PgClient
  | SqlClient.SqlClient;

/** `std upgrade` cannot run now. Nothing was changed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UpgradeRefused extends Schema.TaggedError<UpgradeRefused>()(
  "UpgradeRefused",
  {
    /** The database encoding, for `encoding`. */
    encoding: Schema.NullOr(Schema.String),
    reason: UpgradeRefusal,
    /** PIDs of the blocking sessions: the `std-server` sessions, or the `SCHEMA_KEY` holder. */
    sessions: Schema.Array(Schema.Int),
  }
) {
  /**
   * Explains the refusal with nothing from the database but PIDs and the encoding.
   * @returns The message.
   */
  override get message(): string {
    const pids = this.sessions.join(", ");

    if (this.reason === ENCODING_REFUSAL) {
      return `std upgrade refuses a database with encoding ${this.encoding ?? "unknown"}; STD needs UTF8`;
    }

    if (this.reason === SERVERS_REFUSAL) {
      return `std upgrade refuses to run while std-server sessions are connected (pids ${pids}); stop the servers and workers (std-worker) first`;
    }

    return `SCHEMA_KEY is held by another session (pids ${pids}); a change set or another upgrade is running`;
  }
}

/** What happened to one migration in an upgrade. */
export interface MigrationOutcome {
  readonly id: number;
  readonly name: string;
  readonly kind: SchemaMigration["kind"];
  /**
   * `applied`: ran now. `recorded`: a valid index already existed (a build
   * that finished after its client died). `rebuilt`: an invalid index was
   * dropped and built again.
   */
  readonly outcome: "applied" | "recorded" | "rebuilt";
}

/** Errors of the migration step. */
export type UpgradeError =
  | MigrationStateRefused
  | UpgradeRefused
  | DatabaseError;

const decodeEncoding = decodeRows(
  Schema.Struct({ encoding: Schema.String, utf8: Schema.Boolean })
);

const decodePids = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeValidity = decodeRows(Schema.Struct({ valid: Schema.Boolean }));

/**
 * The server's startup check.
 * @param migrations - The code's migrations (default: all platform migrations).
 * @returns Succeeds only when the ledger matches the code exactly.
 */
export const checkPlatformMigrations: (
  migrations?: readonly PlatformMigration[]
) => Effect.Effect<
  void,
  MigrationStateRefused | DatabaseError,
  SqlClient.SqlClient
> = Effect.fn("Platform.checkMigrations")(
  function* checkLedgerAtStartup(
    migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
  ) {
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* readLedger(sql);

    const refusal = refusalOf(
      compareLedger(migrations, ledger, yield* installedSetVersions(sql)),
      false
    );

    if (refusal !== undefined) {
      return yield* refusal;
    }

    return yield* Effect.void;
  },
  (effect) => hygienic(effect)
);

/** What `checkUpgradePreconditions` lets through. */
export interface PreconditionOptions {
  /**
   * Return the PIDs of connected `std-server` sessions instead of refusing
   * (`std upgrade --plan`, which changes nothing).
   */
  readonly allowServers?: boolean;
}

/**
 * Refuses the upgrade on a non-UTF8 database or while `std-server` or
 * `std-worker` sessions are connected to it (Contracts 8.5: the outbox
 * worker counts as a server).
 * @param sql - A client connected to the database.
 * @param options - Whether connected servers are only reported.
 * @returns The PIDs of connected `std-server` sessions (empty unless allowed).
 */
export const checkUpgradePreconditions: (
  sql: SqlClient.SqlClient,
  options?: PreconditionOptions
) => Effect.Effect<readonly number[], UpgradeRefused | DatabaseError> =
  Effect.fn("Platform.checkUpgradePreconditions")(
    function* checkUpgradeGuards(
      sql: SqlClient.SqlClient,
      options: PreconditionOptions = {}
    ) {
      const [database] = yield* sql`
        SELECT pg_encoding_to_char(encoding) AS encoding,
               encoding = pg_char_to_encoding('UTF8') AS utf8
        FROM pg_database WHERE datname = current_database()`.pipe(
        Effect.flatMap(decodeEncoding)
      );

      const encoding = database?.encoding ?? "unknown";

      if (database?.utf8 !== true) {
        return yield* new UpgradeRefused({
          encoding,
          reason: ENCODING_REFUSAL,
          sessions: [],
        });
      }

      const servers = yield* sql`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND EXISTS (SELECT 1 FROM unnest(${UPGRADE_BLOCKING_APPLICATION_PREFIXES}::text[]) AS names(prefix)
            WHERE application_name = prefix OR starts_with(application_name, prefix || '@'))
          AND pid <> pg_backend_pid()
        ORDER BY pid`.pipe(Effect.flatMap(decodePids));

      const pids = servers.map((row) => row.pid);

      if (pids.length > 0 && options.allowServers !== true) {
        return yield* new UpgradeRefused({
          encoding,
          reason: SERVERS_REFUSAL,
          sessions: pids,
        });
      }

      return pids;
    },
    (effect) => hygienic(effect)
  );

const schemaBusy = (
  connection: DedicatedConnection
): Effect.Effect<UpgradeRefused, DatabaseError> =>
  connection
    .execute(
      `SELECT pid FROM pg_locks
       WHERE locktype = 'advisory' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND classid = $1::oid AND objid = $2::oid AND objsubid = 1`,
      [
        String(advisoryClassId(SCHEMA_KEY)),
        String(advisoryObjectId(SCHEMA_KEY)),
      ]
    )
    .pipe(
      Effect.flatMap(decodePids),
      Effect.map(
        (rows) =>
          new UpgradeRefused({
            encoding: null,
            reason: SCHEMA_BUSY_REFUSAL,
            sessions: rows.map((row) => row.pid),
          })
      )
    );

const applyTx = (
  connection: DedicatedConnection,
  migration: TxMigration
): Effect.Effect<void, DatabaseError> =>
  connection.transactions.maintenance(
    Effect.gen(function* applyTxMigration() {
      const sql = yield* SqlClient.SqlClient;

      for (const statement of migration.statements) {
        yield* sql.unsafe(statement).unprepared;
      }

      const [columns] = yield* sql
        .unsafe(LEDGER_COLUMNS)
        .pipe(Effect.flatMap(decodeLedgerColumns));

      yield* columns?.phased === true
        ? sql`INSERT INTO core.platform_migration (id, checksum, std_version, phase)
          VALUES (${migration.id}, ${migrationChecksum(migration)}, ${STD_VERSION}, ${migration.phase})`
        : sql`INSERT INTO core.platform_migration (id, checksum, std_version)
          VALUES (${migration.id}, ${migrationChecksum(migration)}, ${STD_VERSION})`;
    }),
    {
      lockTimeout: MIGRATION_LOCK_TIMEOUT,
      statementTimeout: MIGRATION_STATEMENT_TIMEOUT,
    }
  );

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const applyConcurrentIndex = (
  connection: DedicatedConnection,
  migration: ConcurrentIndexMigration
): Effect.Effect<MigrationOutcome["outcome"], DatabaseError> =>
  Effect.gen(function* applyConcurrentIndexMigration() {
    const [probe] = yield* connection
      .execute(
        `SELECT i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [migration.schema, migration.index]
      )
      .pipe(Effect.flatMap(decodeValidity));

    let outcome: MigrationOutcome["outcome"] = "applied";

    if (probe?.valid === true) {
      outcome = "recorded";
    } else {
      if (probe !== undefined) {
        outcome = "rebuilt";
        yield* connection.execute(
          `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(migration.schema)}.${quoteIdentifier(migration.index)}`
        );
      }

      // Concurrent builds wait for older transactions; no timeout applies.
      yield* connection.execute("SET lock_timeout = 0");
      yield* connection.execute("SET statement_timeout = 0");
      yield* connection.execute(migration.statement);
    }

    const [columns] = yield* connection
      .execute(LEDGER_COLUMNS)
      .pipe(Effect.flatMap(decodeLedgerColumns));

    const phased = columns?.phased === true;

    yield* connection.execute(
      phased
        ? "INSERT INTO core.platform_migration (id, checksum, std_version, phase) VALUES ($1, $2, $3, $4)"
        : "INSERT INTO core.platform_migration (id, checksum, std_version) VALUES ($1, $2, $3)",
      [
        migration.id,
        migrationChecksum(migration),
        STD_VERSION,
        ...(phased ? [migration.phase] : []),
      ]
    );

    return outcome;
  });

const applyMigration: (
  connection: DedicatedConnection,
  migration: SchemaMigration
) => Effect.Effect<MigrationOutcome, DatabaseError> = Effect.fn(
  "Platform.applyMigration"
)(function* applyPlatformMigration(
  connection: DedicatedConnection,
  migration: SchemaMigration
) {
  yield* Effect.logInfo(
    `Applying platform migration ${migration.id} (${migration.name})`
  );

  yield* connection.execute("SET standard_conforming_strings = on");

  const outcome =
    migration.kind === "tx"
      ? yield* applyTx(connection, migration).pipe(
          Effect.as("applied" as const)
        )
      : yield* applyConcurrentIndex(connection, migration);

  return {
    id: migration.id,
    kind: migration.kind,
    name: migration.name,
    outcome,
  };
});

/**
 * Applies the pending `tx` and `concurrent_index` migrations on a
 * connection that already holds `SCHEMA_KEY` (`std upgrade` holds it for
 * the whole run). Refuses an unknown or changed ledger entry before
 * applying anything. `data` migrations need the sets loaded first; they
 * run later (`data-migrations.ts`).
 * @param connection - A dedicated connection holding `SCHEMA_KEY`.
 * @param migrations - The code's migrations (default: all platform migrations).
 * @returns What happened to each pending migration, in order.
 */
export const applyPendingMigrations: (
  connection: DedicatedConnection,
  migrations?: readonly PlatformMigration[]
) => Effect.Effect<
  readonly MigrationOutcome[],
  MigrationStateRefused | DatabaseError
> = Effect.fn("Platform.applyPendingMigrations")(
  function* applyPendingMigrations(
    connection: DedicatedConnection,
    migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
  ) {
    const ledger = yield* hygienic(readLedger(connection.client));
    const comparison = compareLedger(migrations, ledger);
    const refusal = refusalOf(comparison, true);

    if (refusal !== undefined) {
      return yield* refusal;
    }

    const outcomes: MigrationOutcome[] = [];

    for (const migration of comparison.pending.filter(isSchemaMigration)) {
      outcomes.push(yield* applyMigration(connection, migration));
    }

    return outcomes;
  }
);

/**
 * Refuses with `UpgradeRefused` (`schema-busy`) naming the `SCHEMA_KEY`
 * holders, after a failed `pg_try_advisory_lock`.
 * @param connection - The connection that tried to take the lock.
 * @returns Always fails.
 */
export const refuseSchemaBusy = (
  connection: DedicatedConnection
): Effect.Effect<never, UpgradeRefused | DatabaseError> =>
  schemaBusy(connection).pipe(Effect.flatMap(Effect.fail));

/**
 * The migration step of `std upgrade` (`tx` and `concurrent_index`
 * migrations; the test harness builds its templates with it).
 * @param migrations - The code's migrations (default: all platform migrations).
 * @returns What happened to each pending migration, in order.
 */
export const runPlatformMigrations: (
  migrations?: readonly PlatformMigration[]
) => Effect.Effect<readonly MigrationOutcome[], UpgradeError, UpgradeServices> =
  Effect.fn("Platform.runMigrations")(function* upgradePlatform(
    migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
  ): Effect.fn.Return<
    readonly MigrationOutcome[],
    UpgradeError,
    Scope.Scope | UpgradeServices
  > {
    const pool = yield* SqlClient.SqlClient;
    yield* checkUpgradePreconditions(pool);
    const connection = yield* makeDedicatedConnection();

    if (!(yield* connection.tryAdvisoryLock(SCHEMA_KEY))) {
      return yield* refuseSchemaBusy(connection);
    }

    const outcomes = yield* applyPendingMigrations(connection, migrations);

    yield* connection.advisoryUnlock(SCHEMA_KEY);

    return outcomes;
  }, Effect.scoped);
