/**
 * Migration 0002: the definition tables, the schema-change journal, the
 * dependency index and definition revisions (Contracts 1.2 to 1.7, 4.4).
 *
 * Definition and journal tables are laid out like STD root classes (2.1):
 * `id`, `class_id`, `version` and the audit columns, `PRIMARY KEY (id)`,
 * `UNIQUE (id, class_id)`, a subtree CHECK holding the table's platform
 * class ID and the class-change trigger. The `core` definition set
 * describes them as classes, so they appear in the API; the loader only
 * verifies them.
 *
 * Audit columns of platform tables carry user IDs without a foreign key:
 * `core.user` is created later, by the core set. The engine writes the
 * system user's ID for set loads; `doctor` (workstream 1B) checks that
 * every audit ID exists in `core.user`. Every foreign key between platform
 * tables is `NO ACTION` (Contracts 3.10) and deferrable, initially
 * deferred, so a change set writes definition rows in any order.
 *
 * This file is frozen once applied: the ledger records its checksum. The
 * helper below is part of it and must not change either.
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

const ENFORCEMENT_COLUMNS = [
  "enforcement text NOT NULL CHECK (enforcement IN ('pending', 'enforced', 'failed'))",
  "enforcement_note text",
] as const;

const NAME = "name text NOT NULL";

const LABEL = "label text NOT NULL";

const HELP_TEXT = "help_text text";

const CLASS_TABLE = 'core."class"';

const STORAGE =
  "storage text NOT NULL CHECK (storage IN ('standard', 'platform'))";

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

/** Migration 0002. Never edit it: the ledger records its checksum. */
export const migration0002: TxMigration = {
  id: 2,
  kind: "tx",
  name: "definitions",
  statements: [
    ...platformTable(
      "namespace",
      [
        ...DEFINITION_COLUMNS,
        NAME,
        LABEL,
        HELP_TEXT,
        STORAGE,
        "extensible boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("namespace_name_live", "namespace", "name"),
    ...platformTable(
      "class",
      [
        ...DEFINITION_COLUMNS,
        ...ENFORCEMENT_COLUMNS,
        `namespace_id uuid NOT NULL ${deferred('core."namespace"')}`,
        NAME,
        LABEL,
        HELP_TEXT,
        `parent_id uuid ${deferred(CLASS_TABLE)}`,
        "display_field_id uuid",
        STORAGE,
        "extensible boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("class_name_live", "class", "namespace_id, name"),
    'CREATE INDEX class_parent ON core."class" (parent_id)',
    ...platformTable(
      "field",
      [
        ...DEFINITION_COLUMNS,
        ...ENFORCEMENT_COLUMNS,
        `table_id uuid NOT NULL ${deferred(CLASS_TABLE)}`,
        NAME,
        LABEL,
        HELP_TEXT,
        "type jsonb NOT NULL",
        "required boolean NOT NULL",
        "read_only boolean NOT NULL",
        "default_value jsonb",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("field_name_live", "field", "table_id, name"),
    `ALTER TABLE core."class" ADD CONSTRAINT class_display_field FOREIGN KEY (display_field_id) ${deferred('core."field"')}`,
    ...platformTable(
      "field_override",
      [
        ...DEFINITION_COLUMNS,
        ...ENFORCEMENT_COLUMNS,
        `table_id uuid NOT NULL ${deferred(CLASS_TABLE)}`,
        `field_id uuid NOT NULL ${deferred('core."field"')}`,
        "label text",
        HELP_TEXT,
        "required boolean",
        "read_only boolean",
        "max_length integer",
        "min_value jsonb",
        "max_value jsonb",
        "default_value jsonb",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("field_override_live", "field_override", "table_id, field_id"),
    ...platformTable(
      "index",
      [
        ...DEFINITION_COLUMNS,
        ...ENFORCEMENT_COLUMNS,
        `table_id uuid NOT NULL ${deferred(CLASS_TABLE)}`,
        "field_ids jsonb NOT NULL",
        "is_unique boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    'CREATE INDEX index_table ON core."index" (table_id)',
    ...platformTable(
      "role",
      [...DEFINITION_COLUMNS, NAME, LABEL, HELP_TEXT],
      [OWNER_CHECK]
    ),
    liveUnique("role_name_live", "role", "name"),
    ...platformTable(
      "permission",
      [...DEFINITION_COLUMNS, NAME, LABEL, HELP_TEXT],
      [OWNER_CHECK]
    ),
    liveUnique("permission_name_live", "permission", "name"),
    ...platformTable(
      "role_permission",
      [
        ...DEFINITION_COLUMNS,
        `role_id uuid NOT NULL ${deferred('core."role"')}`,
        `permission_id uuid NOT NULL ${deferred('core."permission"')}`,
      ],
      [OWNER_CHECK]
    ),
    liveUnique(
      "role_permission_live",
      "role_permission",
      "role_id, permission_id"
    ),
    ...platformTable(
      "access_rule",
      [
        ...DEFINITION_COLUMNS,
        "description text",
        "effect text NOT NULL CHECK (effect IN ('allow', 'deny'))",
        "role_ids jsonb NOT NULL",
        `table_id uuid ${deferred(CLASS_TABLE)}`,
        "target text NOT NULL CHECK (target IN ('records', 'fields'))",
        "fields jsonb",
        "actions jsonb NOT NULL",
        "condition jsonb",
        "active boolean NOT NULL",
      ],
      [OWNER_CHECK, "CHECK ((target = 'records') = (fields IS NULL))"]
    ),
    'CREATE INDEX access_rule_table ON core."access_rule" (table_id)',
    ...platformTable(
      "subscription",
      [
        ...DEFINITION_COLUMNS,
        NAME,
        `table_id uuid NOT NULL ${deferred(CLASS_TABLE)}`,
        "operations jsonb NOT NULL",
        "condition jsonb",
        "identity_id uuid NOT NULL",
        "max_attempts integer NOT NULL CHECK (max_attempts > 0)",
        "dead_letter text NOT NULL CHECK (dead_letter IN ('block', 'skip'))",
        "enabled boolean NOT NULL",
      ],
      [OWNER_CHECK]
    ),
    liveUnique("subscription_name_live", "subscription", "name"),
    ...platformTable("schema_change", [
      "requester_id uuid NOT NULL",
      "source jsonb NOT NULL",
      "operations jsonb NOT NULL",
      "state text NOT NULL CHECK (state IN ('applying', 'completed', 'needs_attention', 'abandoned'))",
      "first_revision bigint",
      "last_revision bigint",
      "error text",
      "coordinator_pid integer",
      "committed_at timestamptz(3)",
      "completed_at timestamptz(3)",
    ]),
    "CREATE INDEX schema_change_open ON core.\"schema_change\" (state) WHERE state IN ('applying', 'needs_attention')",
    'CREATE UNIQUE INDEX schema_change_first_revision ON core."schema_change" (first_revision)',
    ...platformTable(
      "schema_change_step",
      [
        `change_id uuid NOT NULL ${deferred('core."schema_change"')}`,
        "ordinal integer NOT NULL CHECK (ordinal > 0)",
        "kind text NOT NULL CHECK (kind IN ('validate_constraint', 'validate_override', 'create_index_concurrently', 'drop_index_concurrently', 'complete', 'backfill'))",
        "target_id uuid",
        "sql text",
        "details jsonb NOT NULL",
        "state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed'))",
        "attempts integer NOT NULL CHECK (attempts >= 0)",
        "last_error text",
        "backend_pid integer",
        "started_at timestamptz(3)",
        "finished_at timestamptz(3)",
      ],
      ["UNIQUE (change_id, ordinal)"]
    ),
    `CREATE TABLE core.config_dependency (
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (from_id, kind, to_id)
)`,
    "CREATE INDEX config_dependency_to ON core.config_dependency (to_id)",
    `CREATE TABLE core.definition_revision (
  definition_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  kind text NOT NULL,
  effective jsonb NOT NULL,
  PRIMARY KEY (definition_id, revision)
)`,
    `COMMENT ON TABLE core.config_dependency IS
  'Every reference between config records (Contracts 1.7), maintained by the schema engine in each change set.'`,
    `COMMENT ON TABLE core.definition_revision IS
  'Effective JSON of each definition per revision (Contracts 4.4); resolve revision R from the latest row with revision <= R.'`,
  ],
};
