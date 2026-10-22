/**
 * Platform migrations (Contracts 1.9): numbered, forward-only changes to the
 * platform tables, recorded in `core.platform_migration`.
 *
 * A migration is TypeScript data, not a `.sql` file, because the driver has
 * no simple-query protocol: every statement is sent on its own, so a
 * migration lists its statements one by one (a PL/pgSQL body in `$$` quotes
 * is one statement).
 *
 * - Kind `tx` runs all its statements and its ledger row in one READ
 *   COMMITTED transaction with `lock_timeout = '2s'` and
 *   `statement_timeout = '15s'` (Contracts 1.4).
 * - Kind `concurrent_index` is exactly one statement of the form
 *   `CREATE [UNIQUE] INDEX CONCURRENTLY <name> ON ...` with a fixed
 *   index name. The runner probes
 *   `pg_index`: a valid index is recorded, an invalid one is dropped and
 *   rebuilt, a missing one is built; the ledger row follows in its own
 *   transaction.
 * - Kind `data` (Contracts 1.9, decision 0021 item 29) changes records
 *   through the save pipeline as the system user, in batches, after the
 *   sets load (`data-migrations.ts`). Its ledger row is `running` from its
 *   start until its last batch commits; each batch commits its records with
 *   the row's `progress`, a keyset cursor, so a killed run resumes.
 */
import { createHash } from "node:crypto";

import { Schema } from "effect";
import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";

import type { Actor } from "../auth/actor.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { SaveHooks } from "../records/save-hooks.ts";
import type { WriteAccess } from "../records/write-access.ts";
import type { WriteOnlyValues } from "../records/write-only-values.ts";
import type { RequestRevision } from "../sql/request-revision.ts";
import type { Transactions } from "../sql/transactions.ts";

/** A migration that runs in one transaction. */
export interface TxMigration {
  readonly id: number;
  /** Short kebab-case description, for reports. */
  readonly name: string;
  readonly kind: "tx";
  readonly statements: readonly string[];
}

/** A migration that builds one index concurrently, outside any transaction. */
export interface ConcurrentIndexMigration {
  readonly id: number;
  readonly name: string;
  readonly kind: "concurrent_index";
  /** Schema of the index (and its table). */
  readonly schema: string;
  /** The fixed index name the runner probes for. */
  readonly index: string;
  /** `CREATE [UNIQUE] INDEX CONCURRENTLY <index> ON <schema>.<table> ...`. */
  readonly statement: string;
}

/** What one batch of a `data` migration did. */
export interface DataBatch {
  /** How many records the batch changed. */
  readonly changed: number;
  /**
   * The keyset cursor after the batch's last record, or null when nothing
   * is left: the batch that returns null sets the row `applied`.
   */
  readonly next: string | null;
}

/** A `data` migration batch failed; the ledger row stays `running`. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DataMigrationFailed extends Schema.TaggedError<
  DataMigrationFailed,
  { readonly brand: unique symbol }
>()("DataMigrationFailed", {
  id: Schema.Int,
  /** The migration's name. */
  migration: Schema.String,
  /** The refusal of the save that failed, without record values. */
  reason: Schema.String,
}) {
  /**
   * Names the migration and the refusal.
   * @returns The message.
   */
  override get message(): string {
    return `Data migration ${this.id} (${this.migration}) failed: ${this.reason}; it stays incomplete, and std serve refuses to start until a rerun of std upgrade completes it`;
  }
}

/**
 * What a `data` migration's batch runs with: the record service, inside a
 * request transaction the runner opens, as the system user with every
 * record allowed and the outbox producer as its hooks.
 */
export type DataBatchServices =
  | Actor
  | Catalog
  | RequestRevision
  | SaveHooks
  | SqlClient.SqlClient
  | Transactions
  | WriteAccess
  | WriteOnlyValues;

/**
 * A migration that changes records through the save pipeline as the
 * system user, in batches.
 */
export interface DataMigration {
  readonly id: number;
  readonly name: string;
  readonly kind: "data";
  /**
   * What the migration changes, in words. The ledger's checksum is its
   * hash, so the text changes whenever what the migration does changes.
   */
  readonly description: string;
  /**
   * One batch: changes up to `size` records whose key is after `after`
   * (null: from the start) and that still need the change, so a rerun
   * changes nothing.
   */
  readonly batch: (
    after: string | null,
    size: number
  ) => Effect.Effect<DataBatch, DataMigrationFailed, DataBatchServices>;
  /**
   * How many records still need the change, counted in the final batch's
   * transaction: the row becomes `applied` only when it is 0.
   */
  readonly remaining: Effect.Effect<
    number,
    DataMigrationFailed,
    DataBatchServices
  >;
}

/** Any platform migration. */
export type PlatformMigration =
  | TxMigration
  | ConcurrentIndexMigration
  | DataMigration;

/** A migration `std upgrade` runs before the sets load. */
export type SchemaMigration = TxMigration | ConcurrentIndexMigration;

/**
 * Whether a migration runs before the sets load (`tx`,
 * `concurrent_index`), not after them (`data`).
 * @param migration - A migration.
 * @returns True for `tx` and `concurrent_index`.
 */
export const isSchemaMigration = (
  migration: PlatformMigration
): migration is SchemaMigration => migration.kind !== "data";

/**
 * Whether a migration is a `data` migration.
 * @param migration - A migration.
 * @returns True for `data`.
 */
export const isDataMigration = (
  migration: PlatformMigration
): migration is DataMigration => migration.kind === "data";

const checksumInput = (migration: PlatformMigration): readonly string[] => {
  if (migration.kind === "tx") {
    return migration.statements;
  }

  return migration.kind === "data"
    ? [migration.name, migration.description]
    : [migration.statement];
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

const CONCURRENT_INDEX =
  /^\s*create\s+(?:unique\s+)?index\s+concurrently\s+(?<name>[a-z_][a-z0-9_]*)\s+on\s+(?<schema>[a-z_][a-z0-9_]*)\./iu;

/**
 * The checksum recorded in the ledger: SHA-256 over the kind and the
 * statements (of a `data` migration: its name and description).
 * @param migration - A migration.
 * @returns 64 lowercase hex digits.
 */
export const migrationChecksum = (migration: PlatformMigration): string =>
  createHash("sha256")
    .update(JSON.stringify([migration.kind, ...checksumInput(migration)]))
    .digest("hex");

/**
 * Checks a migration list: ids 1, 2, 3 ... in order, and every
 * `concurrent_index` migration's statement builds the index it names.
 * @param migrations - The list, in order.
 * @returns The same list.
 */
export const validateMigrations = (
  migrations: readonly PlatformMigration[]
): readonly PlatformMigration[] => {
  for (const [index, migration] of migrations.entries()) {
    if (migration.id !== index + 1) {
      throw new Error(
        `Platform migration ids must be consecutive from 1; found ${migration.id} at position ${index + 1}`
      );
    }

    if (migration.kind === "concurrent_index") {
      const match = CONCURRENT_INDEX.exec(migration.statement);

      if (
        !(
          IDENTIFIER.test(migration.index) && IDENTIFIER.test(migration.schema)
        ) ||
        match?.groups?.name !== migration.index ||
        match.groups.schema !== migration.schema
      ) {
        throw new Error(
          `Platform migration ${migration.id} must be one CREATE INDEX CONCURRENTLY ${migration.index} ON ${migration.schema}.<table>`
        );
      }
    } else if (migration.kind === "tx" && migration.statements.length === 0) {
      throw new Error(`Platform migration ${migration.id} has no statements`);
    }
  }

  return migrations;
};
