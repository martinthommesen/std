import type { TxMigration } from "../migration.ts";

/** Persistent sign-in admission and indexed session expiry; additive only. */
export const migration0031: TxMigration = {
  id: 31,
  kind: "tx",
  name: "http-edge",
  phase: "expand",
  statements: [
    `CREATE TABLE core.sign_in_attempt (
      kind text NOT NULL CHECK (kind IN ('login', 'source')),
      key text NOT NULL,
      failures integer NOT NULL CHECK (failures >= 0),
      next_allowed_at timestamptz(3) NOT NULL,
      expires_at timestamptz(3) NOT NULL,
      PRIMARY KEY (kind, key)
    )`,
    "CREATE INDEX sign_in_attempt_expiry ON core.sign_in_attempt (expires_at)",
  ],
};
