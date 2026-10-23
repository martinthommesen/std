/**
 * Migration 0001: the `core` schema, the migration ledger, the config state
 * row, `core.begin_request()` and `core.refuse_class_change()`.
 */
import { CONFIG_KEY } from "../../sql/locks.ts";
import type { TxMigration } from "../migration.ts";

/**
 * SQLSTATE raised by `core.refuse_class_change()`. A custom code in the
 * otherwise unused class `ST`, so the record service can tell it apart.
 */
export const CLASS_CHANGE_REFUSED_SQLSTATE = "ST001";

/** Migration 0001. Never edit it: the ledger records its checksum. */
export const migration0001: TxMigration = {
  id: 1,
  kind: "tx",
  name: "core",
  phase: "expand",
  statements: [
    "CREATE SCHEMA core",
    `CREATE TABLE core.platform_migration (
  id integer PRIMARY KEY CHECK (id > 0),
  checksum text NOT NULL,
  std_version text NOT NULL,
  applied_at timestamptz(3) NOT NULL DEFAULT now()
)`,
    `CREATE TABLE core.config_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0),
  change_set_id uuid NOT NULL
)`,
    "INSERT INTO core.config_state (revision, change_set_id) VALUES (0, uuidv7())",
    `CREATE FUNCTION core.begin_request()
RETURNS TABLE (revision bigint, change_set_id uuid)
LANGUAGE plpgsql VOLATILE
AS $$
#variable_conflict use_column
BEGIN
  -- Shared CONFIG_KEY: waits while a config commit holds it exclusively.
  PERFORM pg_advisory_xact_lock_shared(${CONFIG_KEY.toString()});
  -- A VOLATILE function takes a new snapshot for this query, so it sees a
  -- config commit that finished while the lock call waited.
  RETURN QUERY SELECT s.revision, s.change_set_id FROM core.config_state AS s;
END
$$`,
    `COMMENT ON FUNCTION core.begin_request() IS
  'First statement of every STD request transaction: takes CONFIG_KEY shared, then reads (revision, change_set_id).'`,
    `CREATE FUNCTION core.refuse_class_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'the class of a record cannot change'
    USING ERRCODE = '${CLASS_CHANGE_REFUSED_SQLSTATE}',
          SCHEMA = TG_TABLE_SCHEMA,
          TABLE = TG_TABLE_NAME;
END
$$`,
    `COMMENT ON FUNCTION core.refuse_class_change() IS
  'BEFORE UPDATE row trigger of every STD table, WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id).'`,
  ],
};
