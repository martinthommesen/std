import type { ConcurrentIndexMigration } from "../migration.ts";

/** Legacy client event IDs remain seekable before their lookup backfill. */
export const migration0026: ConcurrentIndexMigration = {
  id: 26,
  index: "change_client_event_key",
  kind: "concurrent_index",
  name: "client-event-key",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY change_client_event_key ON core.change (record_class_id, ((fields->'706416a0-c21d-4346-9dda-283896c78bc9'->'after'->>'eventId')), record_id)",
};
