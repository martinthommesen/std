/**
 * Migration 0008: the UI configuration of Step 2 (plan "Step 2. UI",
 * decision 0017).
 *
 * - `core.choice`: the choices of choice fields, one config record each
 *   (stable ID, key, label, order, hidden), unique per field and key among
 *   live choices.
 * - `core.layout`: form and list layouts, one per table and kind among live
 *   layouts; elements name fields by stable ID.
 * - `core.field.number_prefix`: an auto-numbered field's prefix, and on
 *   `core.field_override` the prefix a child class uses instead, plus the
 *   choice subset a child class allows (`choices`). All three columns are
 *   nullable without a default, so `ADD COLUMN` is catalog-only (1.4).
 * - `core.number_counter`: the last number assigned per field and prefix.
 *   The record service takes the next one in the save transaction with an
 *   upsert that adds 1 to `last_value` and returns it, so numbers are
 *   unique per field and prefix; a rolled-back
 *   save gives its number back, and gaps are allowed. It is internal: it
 *   has no `id` and the core set does not describe it.
 *
 * The choice and layout tables are laid out like the platform tables of
 * migration 0002; the helper below is a copy of that migration's, because
 * applied migrations never change and never import each other.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import { generatedName } from "@std/definitions/ids";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import type { PlatformTable } from "@std/definitions/well-known";

import type { TxMigration } from "../migration.ts";

const ROOT_COLUMNS = [
  "id uuid NOT NULL",
  "class_id uuid NOT NULL",
  "version bigint NOT NULL CHECK (version > 0)",
  "created_at timestamptz(3) NOT NULL",
  "created_by uuid NOT NULL",
  "updated_at timestamptz(3) NOT NULL",
  "updated_by uuid NOT NULL",
] as const;

const DEFINITION_COLUMNS = [
  "owner_layer text NOT NULL CHECK (owner_layer IN ('core', 'app', 'local'))",
  "owner_set_id uuid",
  "state text NOT NULL CHECK (state IN ('active', 'retired', 'purged'))",
  "protected boolean NOT NULL",
] as const;

const OWNER_CHECK =
  "CHECK ((owner_layer = 'app') = (owner_set_id IS NOT NULL))";

const deferred = (target: string): string =>
  `REFERENCES ${target} (id) DEFERRABLE INITIALLY DEFERRED`;

const platformTable = (
  table: PlatformTable,
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

const liveUnique = (
  name: string,
  table: PlatformTable,
  columns: string
): string =>
  `CREATE UNIQUE INDEX ${name} ON core."${table}" (${columns}) WHERE state <> 'purged'`;

/** Migration 0008. Never edit it: the ledger records its checksum. */
export const migration0008: TxMigration = {
  id: 8,
  kind: "tx",
  name: "ui-config",
  phase: "expand",
  statements: [
    'ALTER TABLE core."field" ADD COLUMN number_prefix text',
    'ALTER TABLE core."field_override" ADD COLUMN choices jsonb',
    'ALTER TABLE core."field_override" ADD COLUMN number_prefix text',
    ...platformTable(
      "choice",
      [
        ...DEFINITION_COLUMNS,
        `field_id uuid NOT NULL ${deferred('core."field"')}`,
        "key text NOT NULL",
        "label text NOT NULL",
        "sort_order integer NOT NULL",
        "hidden boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("choice_key_live", "choice", "field_id, key"),
    ...platformTable(
      "layout",
      [
        ...DEFINITION_COLUMNS,
        `table_id uuid NOT NULL ${deferred('core."class"')}`,
        "layout_type text NOT NULL CHECK (layout_type IN ('form', 'list'))",
        "elements jsonb NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("layout_table_live", "layout", "table_id, layout_type"),
    `CREATE TABLE core.number_counter (
  field_id uuid NOT NULL,
  prefix text NOT NULL,
  last_value bigint NOT NULL CHECK (last_value > 0),
  CONSTRAINT number_counter_pkey PRIMARY KEY (field_id, prefix)
)`,
    `COMMENT ON TABLE core.number_counter IS
  'Auto-numbers (decision 0017): the last number assigned per field and prefix, taken in the save transaction.'`,
  ],
};
