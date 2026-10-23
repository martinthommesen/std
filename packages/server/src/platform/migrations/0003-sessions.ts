/**
 * Migration 0003: sign-in sessions (Contracts 3.1, 3.10).
 *
 * `core.session` holds one row per session: the SHA-256 hash of the bearer
 * token (the token itself is never stored), the user and the expiry. It has
 * no `id` column, so it is an internal platform table: the core set does
 * not describe it and no generic record endpoint reaches it.
 *
 * `user_id` carries no foreign key, like the audit columns of the other
 * platform tables: `core.user` is created later, by the core set. A session
 * whose user is gone or inactive never authenticates, because every lookup
 * joins `core.user` and requires `active`.
 *
 * `core.end_user_sessions()` deletes a user's sessions. The change set that
 * creates `core.user` attaches it as an `AFTER UPDATE` row trigger that
 * fires when `active` turns false (`auth/session-revocation.ts`), so every
 * path that deactivates a user, the record service or plain SQL, ends the
 * user's sessions in the same transaction (Contracts 3.10).
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0003. Never edit it: the ledger records its checksum. */
export const migration0003: TxMigration = {
  id: 3,
  kind: "tx",
  name: "sessions",
  phase: "expand",
  statements: [
    `CREATE TABLE core.session (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  CHECK (expires_at > created_at)
)`,
    "CREATE INDEX session_by_user ON core.session (user_id)",
    `CREATE FUNCTION core.end_user_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM core.session WHERE user_id = NEW.id;
  RETURN NULL;
END
$$`,
    `COMMENT ON FUNCTION core.end_user_sessions() IS
  'AFTER UPDATE row trigger of core.user, WHEN the user is deactivated: ends every session of the user.'`,
    `COMMENT ON TABLE core.session IS
  'Sign-in sessions: SHA-256 of the bearer token, never the token. Internal platform table (no id column).'`,
  ],
};
