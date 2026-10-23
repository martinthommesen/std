/**
 * Migration 0009: saved list filters (plan Step 2, workstream 2D,
 * decision 0019).
 *
 * - `core.saved_filter`: one config record per saved filter of a table
 *   (stable ID, owner layer, name unique per table among live filters,
 *   label, and a `filter`-profile condition AST that names fields by
 *   stable ID, so renames never break it).
 *
 * The table is laid out like the platform tables of migration 0002; the
 * helper below is a copy of migration 0008's, because applied migrations
 * never change and never import each other.
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

/** Migration 0009. Never edit it: the ledger records its checksum. */
export const migration0009: TxMigration = {
  id: 9,
  kind: "tx",
  name: "saved-filters",
  phase: "expand",
  statements: [
    ...platformTable(
      "saved_filter",
      [
        ...DEFINITION_COLUMNS,
        `table_id uuid NOT NULL ${deferred('core."class"')}`,
        "name text NOT NULL",
        "label text NOT NULL",
        "condition jsonb NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("saved_filter_name_live", "saved_filter", "table_id, name"),
  ],
};
