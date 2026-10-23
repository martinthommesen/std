import type { ConcurrentIndexMigration } from "../migration.ts";

/** Ordered resource-topic history reads, built without blocking saves. */
export const migration0020: ConcurrentIndexMigration = {
  id: 20,
  index: "change_topic_page",
  kind: "concurrent_index",
  name: "change-topic-page",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY change_topic_page ON core.change (record_class_id, occurred_at DESC, id DESC)",
};
