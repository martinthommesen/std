/**
 * Migration 0005: the config layer tables (Contracts 8.1, 8.2).
 *
 * - `core.config_set`: installed definition sets (ID, layer, version, hash,
 *   required sets).
 * - `core.config_base`: one row per shipped record, keyed by the record's
 *   ID: its set, the set version that last shipped it, kind, shipped
 *   properties, their hash, and whether the set removed it.
 * - `core.config_override`: one row per locally overridden property of a
 *   shipped record: local value, `base_when_set`, who and when.
 * - `core.config_conflict`: upgrade conflicts and their resolutions, and
 *   `converged` entries.
 *
 * Laid out like root classes, as migration 0002's tables (Contracts 1.9):
 * the core set describes them as platform classes, so they appear in the
 * API. Every foreign key is `NO ACTION` (Contracts 3.10), deferrable and
 * initially deferred, so a change set writes rows in any order.
 *
 * This file is frozen once applied: the ledger records its checksum. The
 * helper below is part of it and must not change either.
 */
import { generatedName } from "@std/definitions/ids";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";

import type { TxMigration } from "../migration.ts";

/** The tables this migration creates. */
type LayerTable =
  | "config_set"
  | "config_base"
  | "config_override"
  | "config_conflict";

const ROOT_COLUMNS = [
  "id uuid NOT NULL",
  "class_id uuid NOT NULL",
  "version bigint NOT NULL CHECK (version > 0)",
  "created_at timestamptz(3) NOT NULL",
  "created_by uuid NOT NULL",
  "updated_at timestamptz(3) NOT NULL",
  "updated_by uuid NOT NULL",
] as const;

const deferred = (target: string): string =>
  `REFERENCES ${target} (id) DEFERRABLE INITIALLY DEFERRED`;

/**
 * The CREATE TABLE and CREATE TRIGGER statements of one platform table.
 *
 * @param table - The table name in `core`.
 * @param columns - Its own columns, after the root columns.
 * @param constraints - Table constraints after the root constraints.
 * @returns Two statements.
 */
const platformTable = (
  table: LayerTable,
  columns: readonly string[],
  constraints: readonly string[] = []
): readonly string[] => {
  const classId = PLATFORM_CLASS_IDS[table];

  const body = [
    ...ROOT_COLUMNS,
    ...columns,
    `CONSTRAINT ${generatedName("pk", classId)} PRIMARY KEY (id)`,
    `CONSTRAINT ${generatedName("uq", classId)} UNIQUE (id, class_id)`,
    `CONSTRAINT ${generatedName("sc", classId)} CHECK (class_id IN ('${classId}'::uuid))`,
    ...constraints,
  ];

  return [
    `CREATE TABLE core."${table}" (\n  ${body.join(",\n  ")}\n)`,
    `CREATE TRIGGER ${generatedName("tg", classId)} BEFORE UPDATE ON core."${table}" FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
  ];
};

const SET_VERSION = "set_version integer NOT NULL CHECK (set_version > 0)";

/** Migration 0005. Never edit it: the ledger records its checksum. */
export const migration0005: TxMigration = {
  id: 5,
  kind: "tx",
  name: "config-layers",
  statements: [
    ...platformTable("config_set", [
      "name text NOT NULL",
      "layer text NOT NULL CHECK (layer IN ('core', 'app'))",
      SET_VERSION,
      "hash text NOT NULL",
      "requires jsonb NOT NULL",
    ]),
    'CREATE UNIQUE INDEX config_set_name ON core."config_set" (name)',
    ...platformTable("config_base", [
      `set_id uuid NOT NULL ${deferred('core."config_set"')}`,
      SET_VERSION,
      "kind text NOT NULL",
      "shipped jsonb NOT NULL",
      "hash text NOT NULL",
      "removed boolean NOT NULL",
    ]),
    'CREATE INDEX config_base_set ON core."config_base" (set_id)',
    ...platformTable(
      "config_override",
      [
        `record_id uuid NOT NULL ${deferred('core."config_base"')}`,
        "property text NOT NULL",
        "value jsonb NOT NULL",
        "base_when_set jsonb NOT NULL",
        "set_by uuid NOT NULL",
        "set_at timestamptz(3) NOT NULL",
      ],
      ["UNIQUE (record_id, property)"]
    ),
    ...platformTable(
      "config_conflict",
      [
        "record_id uuid NOT NULL",
        "property text NOT NULL",
        `set_id uuid NOT NULL ${deferred('core."config_set"')}`,
        SET_VERSION,
        `change_set_id uuid ${deferred('core."schema_change"')}`,
        "old_shipped jsonb NOT NULL",
        "new_shipped jsonb NOT NULL",
        "local_value jsonb NOT NULL",
        "state text NOT NULL CHECK (state IN ('open', 'resolved'))",
        "resolution text CHECK (resolution IN ('keep_local', 'take_shipped', 'replace', 'converged'))",
        "resolved_value jsonb",
        "resolved_by uuid",
        "resolved_at timestamptz(3)",
      ],
      ["CHECK ((state = 'open') = (resolution IS NULL))"]
    ),
    'CREATE INDEX config_conflict_record ON core."config_conflict" (record_id)',
    "CREATE UNIQUE INDEX config_conflict_open ON core.\"config_conflict\" (record_id, property) WHERE state = 'open'",
    `COMMENT ON TABLE core."config_base" IS
  'The shipped base of every record a definition set ships (Contracts 8.2); written only by std upgrade.'`,
    `COMMENT ON TABLE core."config_override" IS
  'Local overrides of shipped records, one row per property (Contracts 8.2); the definition tables hold the effective record.'`,
  ],
};
