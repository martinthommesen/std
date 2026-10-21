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
 */
import { createHash } from "node:crypto";

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

/** Any platform migration. */
export type PlatformMigration = TxMigration | ConcurrentIndexMigration;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

const CONCURRENT_INDEX =
  /^\s*create\s+(?:unique\s+)?index\s+concurrently\s+(?<name>[a-z_][a-z0-9_]*)\s+on\s+(?<schema>[a-z_][a-z0-9_]*)\./iu;

/**
 * The checksum recorded in the ledger: SHA-256 over the kind and statements.
 * @param migration - A migration.
 * @returns 64 lowercase hex digits.
 */
export const migrationChecksum = (migration: PlatformMigration): string => {
  const statements =
    migration.kind === "tx" ? migration.statements : [migration.statement];

  return createHash("sha256")
    .update(JSON.stringify([migration.kind, ...statements]))
    .digest("hex");
};

/**
 * Checks a migration list: ids 1, 2, 3 ... in order, and every
 * `concurrent_index` migration's statement builds the index it names.
 * @param migrations - The list, in order.
 * @param reserved - Ids held by migrations of branches not merged yet, which
 *   this list skips; empty once every branch is merged.
 * @returns The same list.
 */
export const validateMigrations = (
  migrations: readonly PlatformMigration[],
  reserved: readonly number[] = []
): readonly PlatformMigration[] => {
  const skipped = new Set(reserved);

  const expected = Array.from(
    { length: migrations.length + reserved.length },
    (_, index) => index + 1
  ).filter((id) => !skipped.has(id));

  for (const [index, migration] of migrations.entries()) {
    if (migration.id !== expected[index]) {
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
    } else if (migration.statements.length === 0) {
      throw new Error(`Platform migration ${migration.id} has no statements`);
    }
  }

  return migrations;
};
