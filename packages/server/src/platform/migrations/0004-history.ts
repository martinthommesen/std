/**
 * Migration 0004: `core.change`, the change entries of logical records
 * (Contracts 4.2): exactly one row per committed version, deletes included.
 *
 * The table is laid out like the platform tables of migration 0002 (and so
 * like a root class, Contracts 2.1): `id`, `class_id`, `version`, the audit
 * columns, `PRIMARY KEY (id)`, `UNIQUE (id, class_id)`, the subtree CHECK
 * holding its platform class ID and the class-change trigger. The core set
 * describes it as a protected class that only the admin rule reaches
 * (Contracts 3.2, 3.7).
 *
 * - `id` is the change ID (UUIDv7), the idempotency key everywhere.
 * - `class_id` is the platform class of `core.change` itself, so the class
 *   of the recorded record is `record_class_id`.
 * - An entry never changes: `version` is always 1, `created_by` and
 *   `updated_by` equal `actor_id`, `created_at` and `updated_at` equal
 *   `occurred_at` (CHECKed).
 * - `UNIQUE (record_id, record_version)`: one entry per version and per
 *   delete, whichever endpoint the save came through.
 * - `fields` maps field IDs to `{"before", "after"}` in canonical JSON, or
 *   to `{"changed": true}` for password and secret fields (4.3).
 *
 * Like every platform table, the audit and actor columns have no foreign
 * key (users are deactivated, never deleted, Contracts 3.10), and
 * `record_id` has none because entries outlive deleted records.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0004. Never edit it: the ledger records its checksum. */
export const migration0004: TxMigration = {
  id: 4,
  kind: "tx",
  name: "history",
  statements: [
    `CREATE TABLE core."change" (
  id uuid NOT NULL,
  class_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version = 1),
  created_at timestamptz(3) NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  updated_by uuid NOT NULL,
  operation_id uuid NOT NULL,
  record_id uuid NOT NULL,
  record_class_id uuid NOT NULL,
  record_version bigint NOT NULL CHECK (record_version > 0),
  kind text NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
  actor_id uuid NOT NULL,
  cause jsonb NOT NULL CHECK (jsonb_typeof(cause) = 'object'),
  schema_revision bigint NOT NULL CHECK (schema_revision >= 0),
  occurred_at timestamptz(3) NOT NULL,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT std_pk_edde151df2044639bcbfa4793f86a219 PRIMARY KEY (id),
  CONSTRAINT std_uq_edde151df2044639bcbfa4793f86a219 UNIQUE (id, class_id),
  CONSTRAINT std_sc_edde151df2044639bcbfa4793f86a219 CHECK (class_id IN ('edde151d-f204-4639-bcbf-a4793f86a219'::uuid)),
  CONSTRAINT change_audit CHECK (created_by = actor_id AND updated_by = actor_id AND created_at = occurred_at AND updated_at = occurred_at),
  CONSTRAINT change_record_version UNIQUE (record_id, record_version)
)`,
    `CREATE TRIGGER std_tg_edde151df2044639bcbfa4793f86a219 BEFORE UPDATE ON core."change" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
    'CREATE INDEX change_operation ON core."change" (operation_id)',
    `COMMENT ON TABLE core."change" IS
  'One change entry per committed version of a logical record, deletes included (Contracts 4.2). Admin-only; read history through the record history endpoint (Contracts 3.7).'`,
  ],
};
