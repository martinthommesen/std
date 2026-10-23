import type { ConcurrentIndexMigration } from "../migration.ts";

/** Add the session issuance index without blocking existing writers. */
export const migration0032: ConcurrentIndexMigration = {
  id: 32,
  index: "session_issuance",
  kind: "concurrent_index",
  name: "session-issuance",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY session_issuance ON core.session (user_id, created_at, token_hash)",
};
