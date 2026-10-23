import type { ConcurrentIndexMigration } from "../migration.ts";

/** Add the session expiry index without blocking existing writers. */
export const migration0031: ConcurrentIndexMigration = {
  id: 31,
  index: "session_expiry",
  kind: "concurrent_index",
  name: "session-expiry",
  phase: "expand",
  schema: "core",
  statement:
    "CREATE INDEX CONCURRENTLY session_expiry ON core.session (expires_at, token_hash)",
};
