/**
 * Migration lists for the migration runner tests: the real migration 0001
 * followed by test-only migrations.
 */
import type {
  ConcurrentIndexMigration,
  PlatformMigration,
  TxMigration,
} from "../../src/platform/migration.ts";
import { validateMigrations } from "../../src/platform/migration.ts";
import { migration0001 } from "../../src/platform/migrations/0001-core.ts";

/** The `application_name` of the migration child process's connections. */
export const CHILD_APPLICATION_NAME = "std-migration-child";

/** How long the slow `tx` migration sleeps, in seconds. */
export const SLOW_MIGRATION_SECONDS = 1.5;

/** A `tx` migration slow enough to be killed while it runs. */
export const slowProbeMigration: TxMigration = {
  id: 2,
  kind: "tx",
  name: "slow-probe",
  statements: [
    "CREATE TABLE core.migration_probe (id integer PRIMARY KEY, note text NOT NULL)",
    "INSERT INTO core.migration_probe VALUES (1, 'applied once')",
    `SELECT pg_sleep(${SLOW_MIGRATION_SECONDS})`,
  ],
};

/** A `tx` migration creating a table with rows to index. */
export const itemTableMigration: TxMigration = {
  id: 2,
  kind: "tx",
  name: "item-table",
  statements: [
    "CREATE TABLE core.migration_item (id integer NOT NULL)",
    "INSERT INTO core.migration_item SELECT generate_series(1, 10000)",
  ],
};

/** A `concurrent_index` migration on `core.migration_item`. */
export const itemIndexMigration: ConcurrentIndexMigration = {
  id: 3,
  index: "migration_item_id",
  kind: "concurrent_index",
  name: "item-index",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY migration_item_id ON core.migration_item (id)",
};

/** Migration 0001, then the slow `tx` migration. */
export const SLOW_TX_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations([migration0001, slowProbeMigration]);

/** Migration 0001 and the item table, without the index. */
export const ITEM_TABLE_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations([migration0001, itemTableMigration]);

/** Migration 0001, the item table and its concurrent index. */
export const ITEM_INDEX_MIGRATIONS: readonly PlatformMigration[] =
  validateMigrations([migration0001, itemTableMigration, itemIndexMigration]);

/** The migration lists a child process can run, by name. */
export const MIGRATION_SETS = {
  "item-index": ITEM_INDEX_MIGRATIONS,
  "slow-tx": SLOW_TX_MIGRATIONS,
} satisfies Readonly<Record<string, readonly PlatformMigration[]>>;

/**
 * The migration list a child process was asked to run.
 * @param name - A key of `MIGRATION_SETS`.
 * @returns The list, or an empty list for an unknown name.
 */
export const migrationSet = (
  name: string | undefined
): readonly PlatformMigration[] =>
  name === "item-index" || name === "slow-tx" ? MIGRATION_SETS[name] : [];
