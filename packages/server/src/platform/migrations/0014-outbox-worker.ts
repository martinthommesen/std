/**
 * Migration 0014: `core.delivery.finished_at`, for the outbox worker
 * (Contracts 4.6, workstream 3B, decision 0023).
 *
 * - `finished_at`: when a row became `done` or `dead`. The worker sets it
 *   on both and clears it on retry; `done` rows are deleted 7 days after
 *   it, `dead` rows stay, and the admin view shows when they died. Rows
 *   already `done` or `dead` get the migration's time.
 *
 * Additive only (expand, Contracts 1.4 and the rolling-upgrade rules): a
 * nullable column without a default, no constraint the previous release's
 * writes could violate (its fenced updates do not set the column), no
 * rewrite. The index the retention delete uses is migration 0015, built
 * concurrently.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0014. Never edit it: the ledger records its checksum. */
export const migration0014: TxMigration = {
  id: 14,
  kind: "tx",
  name: "outbox-worker",
  statements: [
    "ALTER TABLE core.delivery ADD COLUMN finished_at timestamptz(3)",
    "UPDATE core.delivery SET finished_at = now() WHERE status IN ('done', 'dead')",
  ],
};
