/**
 * Migration 0013: record rules (plan Step 3, workstream 3A, Contracts
 * 4.10, decision 0022).
 *
 * - `core.record_rule`: one config record per record rule (stable ID,
 *   owner layer, name unique per table among live rules): its class,
 *   phase, `before` kind, order number, operations, `recordRule`-profile
 *   condition, `once`, run-as identity, the subscription of an
 *   `afterCommit` rule, its actions as JSON (field and class IDs only, so
 *   renames never break it) and `active`, the one overridable property.
 *
 * The table is laid out like the platform tables of migration 0002; the
 * helper below is a copy of migration 0009's, because applied migrations
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

/** Migration 0013. Never edit it: the ledger records its checksum. */
export const migration0013: TxMigration = {
  id: 13,
  kind: "tx",
  name: "record-rules",
  statements: [
    ...platformTable(
      "record_rule",
      [
        ...DEFINITION_COLUMNS,
        `table_id uuid NOT NULL ${deferred('core."class"')}`,
        "name text NOT NULL",
        "description text",
        "phase text NOT NULL CHECK (phase IN ('before', 'after', 'afterCommit', 'aggregate'))",
        "rule_kind text CHECK (rule_kind IN ('derive', 'guard', 'invariant'))",
        "sort_order integer NOT NULL",
        "operations jsonb NOT NULL",
        "condition jsonb",
        "once boolean NOT NULL",
        "run_as_id uuid",
        `subscription_id uuid ${deferred('core."subscription"')}`,
        "actions jsonb NOT NULL",
        "active boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("record_rule_name_live", "record_rule", "table_id, name"),
  ],
};
