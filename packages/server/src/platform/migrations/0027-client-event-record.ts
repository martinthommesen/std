import type { ConcurrentIndexMigration } from "../migration.ts";

/** Transactional lookup maintenance seeks by the saved record ID. */
export const migration0027: ConcurrentIndexMigration = {
  id: 27,
  index: "client_event_record",
  kind: "concurrent_index",
  name: "client-event-record",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY client_event_record ON core.client_event (record_id)",
};
