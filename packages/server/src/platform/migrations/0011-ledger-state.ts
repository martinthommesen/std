/**
 * Migration 0011: the ledger's `state` and `progress` (Contracts 1.9,
 * decision 0024), for `data` migrations.
 *
 * - `state`: `running` while a `data` migration has batches left (its row
 *   is inserted `running` when it starts), `applied` once its last batch
 *   committed; `tx` and `concurrent_index` rows are written `applied`, as
 *   every row before this migration was.
 * - `progress`: a `data` migration's keyset cursor and count of changed
 *   records, as JSON, committed with each batch; null for other kinds.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0011. Never edit it: the ledger records its checksum. */
export const migration0011: TxMigration = {
  id: 11,
  kind: "tx",
  name: "ledger-state",
  phase: "expand",
  statements: [
    `ALTER TABLE core.platform_migration
  ADD COLUMN state text NOT NULL DEFAULT 'applied'
    CONSTRAINT platform_migration_state CHECK (state IN ('running', 'applied')),
  ADD COLUMN progress jsonb`,
  ],
};
