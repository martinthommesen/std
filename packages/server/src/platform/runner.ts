/**
 * The platform migration runner (Contracts 1.9, 8.5).
 *
 * - `checkPlatformMigrations` is the server's startup check: it refuses to
 *   start when a migration is pending, when the ledger holds one the code
 *   does not know, or when an applied checksum differs.
 * - `runPlatformMigrations` is the migration step of `std upgrade`. It
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

import { SERVER_APPLICATION_NAME } from "../sql/database-config.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import { makeDedicatedConnection } from "../sql/dedicated.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { decodeRows } from "../sql/rows.ts";
import { STD_VERSION } from "../version.ts";
import { compareLedger, readLedger, refusalOf } from "./ledger.ts";
import type { MigrationStateRefused } from "./ledger.ts";
import { migrationChecksum } from "./migration.ts";
import type {
  ConcurrentIndexMigration,
  PlatformMigration,
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
      return `std upgrade refuses to run while std-server sessions are connected (pids ${pids}); stop the servers first`;
    }

    return `SCHEMA_KEY is held by another session (pids ${pids}); a change set or another upgrade is running`;
  }
}

/** What happened to one migration in an upgrade. */
export interface MigrationOutcome {
  readonly id: number;
  readonly name: string;
  readonly kind: PlatformMigration["kind"];
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
    const refusal = refusalOf(compareLedger(migrations, ledger), false);

    if (refusal !== undefined) {
      return yield* refusal;
    }

    return yield* Effect.void;
  },
  (effect) => hygienic(effect)
);

/**
 * Refuses the upgrade on a non-UTF8 database or while `std-server` sessions
 * are connected to it.
 * @param sql - A client connected to the database.
 * @returns Succeeds when the upgrade may run.
 */
export const checkUpgradePreconditions: (
  sql: SqlClient.SqlClient
) => Effect.Effect<void, UpgradeRefused | DatabaseError> = Effect.fn(
  "Platform.checkUpgradePreconditions"
)(
  function* checkUpgradeGuards(sql: SqlClient.SqlClient) {
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
          AND application_name = ${SERVER_APPLICATION_NAME}
          AND pid <> pg_backend_pid()
        ORDER BY pid`.pipe(Effect.flatMap(decodePids));

    if (servers.length > 0) {
      return yield* new UpgradeRefused({
        encoding,
        reason: SERVERS_REFUSAL,
        sessions: servers.map((row) => row.pid),
      });
    }

    return yield* Effect.void;
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

      yield* sql`
        INSERT INTO core.platform_migration (id, checksum, std_version)
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

    yield* connection.execute(
      "INSERT INTO core.platform_migration (id, checksum, std_version) VALUES ($1, $2, $3)",
      [migration.id, migrationChecksum(migration), STD_VERSION]
    );

    return outcome;
  });

const applyMigration: (
  connection: DedicatedConnection,
  migration: PlatformMigration
) => Effect.Effect<MigrationOutcome, DatabaseError> = Effect.fn(
  "Platform.applyMigration"
)(function* applyPlatformMigration(
  connection: DedicatedConnection,
  migration: PlatformMigration
) {
  yield* Effect.logInfo(
    `Applying platform migration ${migration.id} (${migration.name})`
  );

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
 * The migration step of `std upgrade`.
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
      return yield* schemaBusy(connection).pipe(Effect.flatMap(Effect.fail));
    }

    const ledger = yield* hygienic(readLedger(connection.client));
    const comparison = compareLedger(migrations, ledger);
    const refusal = refusalOf(comparison, true);

    if (refusal !== undefined) {
      return yield* refusal;
    }

    const outcomes: MigrationOutcome[] = [];

    for (const migration of comparison.pending) {
      outcomes.push(yield* applyMigration(connection, migration));
    }

    yield* connection.advisoryUnlock(SCHEMA_KEY);

    return outcomes;
  }, Effect.scoped);
