/**
 * Migration 0011: what the outbox worker needs on `core.delivery`
 * (Contracts 4.6, workstream 3B, decision 0023).
 *
 * - `finished_at`: when a row became `done` or `dead`, set exactly in
 *   those two states (`delivery_finished`). `done` rows are deleted 7 days
 *   after it; `dead` rows stay, and the admin view shows when they died.
 *   Rows that are already `done` or `dead` (only tests and manual
 *   operations could have made them before the worker existed) get the
 *   migration's time.
 * - `delivery_done`: the partial index the retention delete scans, so it
 *   never reads the pending backlog. The table holds no `done` rows before
 *   this release, so the build is quick.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0011. Never edit it: the ledger records its checksum. */
export const migration0011: TxMigration = {
  id: 11,
  kind: "tx",
  name: "outbox-worker",
  statements: [
    "ALTER TABLE core.delivery ADD COLUMN finished_at timestamptz(3)",
    "UPDATE core.delivery SET finished_at = now() WHERE status IN ('done', 'dead')",
    "ALTER TABLE core.delivery ADD CONSTRAINT delivery_finished CHECK ((status IN ('done', 'dead')) = (finished_at IS NOT NULL))",
    "CREATE INDEX delivery_done ON core.delivery (finished_at) WHERE status = 'done'",
  ],
};
