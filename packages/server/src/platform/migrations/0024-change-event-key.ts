import type { ConcurrentIndexMigration } from "../migration.ts";

/** Point reads remain indexed while old writers do not maintain resource_event. */
export const migration0024: ConcurrentIndexMigration = {
  id: 24,
  index: "change_event_key",
  kind: "concurrent_index",
  name: "change-event-key",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY change_event_key ON core.change (core.record_event_id(id, kind))",
};
