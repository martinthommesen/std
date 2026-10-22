/**
 * Migration 0014: the index behind the deletion of old `done` deliveries
 * (Contracts 4.6, decision 0023).
 *
 * - `core.delivery_done`: a partial index on `finished_at` of `done` rows,
 *   so the worker's retention delete never reads the pending backlog.
 *
 * A `concurrent_index` migration, so `std upgrade` builds it without
 * blocking the saves that insert delivery rows.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { ConcurrentIndexMigration } from "../migration.ts";

/** Migration 0014. Never edit it: the ledger records its checksum. */
export const migration0014: ConcurrentIndexMigration = {
  id: 14,
  index: "delivery_done",
  kind: "concurrent_index",
  name: "delivery-done",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY delivery_done ON core.delivery (finished_at) WHERE status = 'done'",
};
