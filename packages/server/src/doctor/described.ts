/**
 * What the definitions say the catalog should hold: the table of each
 * class, its columns, and the names of its generated keys, constraints and
 * indexes (Contracts 1.1, 2.1), plus the internal platform tables that
 * migrations create without describing them as classes.
 */
import type {
  ClassDefinition,
  FieldDefinition,
} from "@std/definitions/definition";
import { generatedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { PLATFORM_MIGRATIONS } from "../platform/migrations.ts";
import { isNotNull } from "../schema/ddl.ts";
import { formatTypeOf } from "../schema/platform-tables.ts";
import { tableKey } from "./catalog-facts.ts";

/** A class with the catalog names of its table. */
export interface DescribedTable {
  readonly definition: ClassDefinition;
  readonly schema: string;
  readonly table: string;
  /** `schema.table`. */
  readonly key: string;
  readonly platform: boolean;
}

/** A column a table should have. */
export interface DescribedColumn {
  readonly name: string;
  readonly type: string;
  /** Null when nullability is not checked (a pending NOT NULL). */
  readonly notNull: boolean | null;
  /** Null when the default is not checked (platform tables). */
  readonly hasDefault: boolean | null;
}

const TIMESTAMP = "timestamp(3) with time zone";

const ROOT_SYSTEM: readonly (readonly [string, string])[] = [
  ["id", "uuid"],
  ["class_id", "uuid"],
  ["version", "bigint"],
  ["created_at", TIMESTAMP],
  ["created_by", "uuid"],
  ["updated_at", TIMESTAMP],
  ["updated_by", "uuid"],
];

const LEVEL_SYSTEM: readonly (readonly [string, string])[] = [
  ["id", "uuid"],
  ["class_id", "uuid"],
];

/**
 * The table of every class (tombstones included).
 *
 * @param snapshot - The configuration.
 * @returns The classes with their table names.
 */
export const describedTables = (
  snapshot: ConfigSnapshot
): readonly DescribedTable[] =>
  snapshot.all("class").flatMap((definition) => {
    const namespace = snapshot.namespace(definition.namespaceId);

    return namespace === undefined
      ? []
      : [
          {
            definition,
            key: tableKey(namespace.name, definition.name),
            platform: definition.storage === "platform",
            schema: namespace.name,
            table: definition.name,
          },
        ];
  });

const systemColumn = (
  [name, type]: readonly [string, string],
  platform: boolean
): DescribedColumn => ({
  hasDefault: platform ? null : false,
  name,
  notNull: true,
  type,
});

const fieldColumn = (
  field: FieldDefinition,
  platform: boolean
): DescribedColumn => {
  if (platform) {
    return {
      hasDefault: null,
      name: field.name,
      notNull: field.required || field.type.kind === "boolean",
      type: formatTypeOf(field.type),
    };
  }

  const active = field.state === "active";

  return {
    hasDefault: field.default !== null || field.type.kind === "boolean",
    name: field.name,
    notNull:
      active && field.enforcement === "pending"
        ? null
        : active && isNotNull(field),
    type: formatTypeOf(field.type),
  };
};

/**
 * The columns a class's table should have: system columns, then its live
 * fields (retired fields keep their column, without NOT NULL).
 *
 * @param snapshot - The configuration.
 * @param described - The table.
 * @returns The columns.
 */
export const describedColumns = (
  snapshot: ConfigSnapshot,
  described: DescribedTable
): readonly DescribedColumn[] => {
  const system =
    described.definition.parentId === null ? ROOT_SYSTEM : LEVEL_SYSTEM;

  return [
    ...system.map((entry) => systemColumn(entry, described.platform)),
    ...snapshot
      .ownFields(described.definition.id)
      .map((field) => fieldColumn(field, described.platform)),
  ];
};

/** The generated keys and trigger of a class table. */
export interface ClassKeys {
  readonly constraints: readonly string[];
  readonly trigger: string;
}

/**
 * The generated keys and trigger every class table has (Contracts 2.1).
 *
 * @param definition - The class.
 * @returns Constraint names and the trigger name.
 */
export const classKeys = (definition: ClassDefinition): ClassKeys => ({
  constraints: [
    generatedName("pk", definition.id),
    generatedName("uq", definition.id),
    generatedName("sc", definition.id),
    ...(definition.parentId === null
      ? []
      : [generatedName("lv", definition.id)]),
  ],
  trigger: generatedName("tg", definition.id),
});

const CREATE_TABLE =
  /^\s*CREATE TABLE (?<schema>[a-z_]+)\."?(?<table>[a-z_]+)"?/u;

/**
 * Tables the platform migrations create, by `schema.table`: described
 * platform tables and internal ones (ledger, config state, dependency
 * index, definition revisions).
 *
 * @returns Their keys.
 */
export const migrationTables = (): ReadonlySet<string> => {
  const keys = new Set<string>();

  for (const migration of PLATFORM_MIGRATIONS) {
    for (const statement of migration.kind === "tx"
      ? migration.statements
      : []) {
      const groups = CREATE_TABLE.exec(statement)?.groups;

      if (groups?.schema !== undefined && groups.table !== undefined) {
        keys.add(tableKey(groups.schema, groups.table));
      }
    }
  }

  return keys;
};
