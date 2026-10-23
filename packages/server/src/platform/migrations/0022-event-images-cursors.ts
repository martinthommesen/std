import type { TxMigration } from "../migration.ts";

/** Derived images and opaque, identity-bound event paging positions. */
export const migration0022: TxMigration = {
  id: 22,
  kind: "tx",
  name: "event-images-cursors",
  phase: "expand",
  statements: [
    `CREATE TABLE core.change_image (
      change_id uuid PRIMARY KEY REFERENCES core.change(id) ON DELETE CASCADE,
      before_image jsonb,
      after_image jsonb,
      CHECK (before_image IS NULL OR jsonb_typeof(before_image) = 'object'),
      CHECK (after_image IS NULL OR jsonb_typeof(after_image) = 'object')
    )`,
    `CREATE TABLE core.event_cursor (
      id uuid PRIMARY KEY,
      identity_id uuid NOT NULL,
      topic_id text NOT NULL,
      query text NOT NULL,
      position jsonb NOT NULL,
      expires_at timestamptz NOT NULL
    )`,
    "CREATE INDEX event_cursor_expiry ON core.event_cursor (expires_at)",
  ],
};
