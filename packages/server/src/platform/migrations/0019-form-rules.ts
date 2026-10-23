/** Additive form-rule storage (decision 0036); applied migration checksums are frozen. */
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

/** Migration 0019. Never edit it: the ledger records its checksum. */
export const migration0019: TxMigration = {
  id: 19,
  kind: "tx",
  name: "form-rules",
  phase: "expand",
  statements: [
    ...platformTable(
      "form_rule",
      [
        ...DEFINITION_COLUMNS,
        `table_id uuid NOT NULL ${deferred('core."class"')}`,
        "name text NOT NULL",
        `field_id uuid NOT NULL ${deferred('core."field"')}`,
        "condition jsonb",
        "sort_order integer NOT NULL",
        "property text NOT NULL CHECK (property IN ('required', 'readOnly', 'hidden', 'choices'))",
        "value jsonb NOT NULL",
        "clear_hidden jsonb",
        "message text",
        "active boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("form_rule_name_live", "form_rule", "table_id, name"),
  ],
};
