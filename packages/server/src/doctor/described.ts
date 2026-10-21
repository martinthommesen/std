/**
 * What the definitions say the catalog should hold for class tables: the
 * table of each class, its columns with their defaults, and the structure
 * of every generated key, constraint, index and trigger (Contracts 1.1,
 * 2.1, 3.10), plus the tables platform migrations create.
 */
import type {
  ClassDefinition,
  Enforcement,
  FieldDefinition,
} from "@std/definitions/definition";
import { generatedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { maxLengthOf } from "@std/values/field-type";

import { SESSION_END_TRIGGER } from "../auth/session-revocation.ts";
import { PLATFORM_MIGRATIONS } from "../platform/migrations.ts";
import { isNotNull } from "../schema/ddl.ts";
import { WIDENED_CHECK_NOTE } from "../schema/plan.ts";
import { formatTypeOf } from "../schema/platform-tables.ts";
import { defaultLiteral } from "../schema/sql-text.ts";
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
  /** The default as a SQL expression, or null for none. */
  readonly default: string | null;
}

/** `pg_constraint.contype` of the constraints STD generates. */
export type ConstraintKind = "p" | "u" | "c" | "f" | "n";

/** A constraint a class table should have, with its structure. */
export interface DescribedConstraint {
  readonly name: string;
  /** `pg_constraint.contype`. */
  readonly type: ConstraintKind;
  readonly columns: readonly string[];
  /** The referenced table and columns of a foreign key. */
  readonly references: {
    readonly table: string;
    readonly columns: readonly string[];
  } | null;
  /** `confdeltype` of a foreign key: `a` (NO ACTION) or `c` (level FK). */
  readonly deleteAction: "a" | "c" | null;
  /** Whether it may be NOT VALID, and why (its enforcement state). */
  readonly enforcement: Enforcement | "widened";
  /** Key or check structure the definition must show. */
  readonly matches: (definition: string) => boolean;
  /** Which check reports a missing one: 2 for keys, 3 for field constraints. */
  readonly check: 2 | 3;
}

/** An index a class table should have. */
export interface DescribedIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly enforcement: Enforcement;
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

const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gu;

const IDENTIFIER_QUOTES = /"/gu;

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

/**
 * The default expression of a field's column.
 *
 * @param field - The field.
 * @returns The SQL constant, or null.
 */
const defaultOf = (field: FieldDefinition): string | null => {
  if (field.default !== null) {
    return defaultLiteral(field.type, field.default);
  }

  return field.type.kind === "boolean" ? "false" : null;
};

const fieldColumn = (field: FieldDefinition): DescribedColumn => {
  const active = field.state === "active";

  return {
    default: defaultOf(field),
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
    ...system.map(([name, type]): DescribedColumn => ({
      default: null,
      name,
      notNull: true,
      type,
    })),
    ...snapshot.ownFields(described.definition.id).map(fieldColumn),
  ];
};

const always = (): boolean => true;

/**
 * Whether a CHECK lists exactly the subtree's class IDs.
 *
 * @param subtreeIds - The class IDs of the subtree.
 * @returns A test of `pg_get_constraintdef`.
 */
const listsSubtree =
  (subtreeIds: readonly string[]) =>
  (definition: string): boolean =>
    [...new Set(definition.match(UUID))].toSorted().join(",") ===
    [...subtreeIds].toSorted().join(",");

/**
 * Whether a CHECK limits a column to a maximum length.
 *
 * @param column - The column.
 * @param length - The maximum length in code points.
 * @returns A test of `pg_get_constraintdef`.
 */
const limitsLength =
  (column: string, length: number) =>
  (definition: string): boolean =>
    definition
      .replaceAll(IDENTIFIER_QUOTES, "")
      .includes(`char_length(${column}) <= ${length}`);

const key = (
  name: string,
  type: "p" | "u",
  columns: readonly string[]
): DescribedConstraint => ({
  check: 2,
  columns,
  deleteAction: null,
  enforcement: "enforced",
  matches: always,
  name,
  references: null,
  type,
});

const foreignKey = (
  name: string,
  columns: readonly string[],
  references: { readonly table: string; readonly columns: readonly string[] },
  options: {
    readonly deleteAction: "a" | "c";
    readonly enforcement: Enforcement;
    readonly check: 2 | 3;
  }
): DescribedConstraint => ({
  ...options,
  columns,
  matches: always,
  name,
  references,
  type: "f",
});

const tableKeyOf = (
  snapshot: ConfigSnapshot,
  classId: string
): string | undefined => {
  const definition = snapshot.class(classId);

  const namespace =
    definition === undefined
      ? undefined
      : snapshot.namespace(definition.namespaceId);

  return definition === undefined || namespace === undefined
    ? undefined
    : tableKey(namespace.name, definition.name);
};

const classConstraints = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): readonly DescribedConstraint[] => {
  const { id, parentId } = definition;
  const parent = parentId === null ? undefined : tableKeyOf(snapshot, parentId);
  const users = tableKeyOf(snapshot, USER_CLASS_ID);
  const auditTo = { columns: ["id"], table: users ?? "" };

  const audit = {
    check: 2,
    deleteAction: "a",
    enforcement: "enforced",
  } as const;

  return [
    key(generatedName("pk", id), "p", ["id"]),
    key(generatedName("uq", id), "u", ["id", "class_id"]),
    {
      check: 2,
      columns: ["class_id"],
      deleteAction: null,
      enforcement:
        definition.enforcementNote === WIDENED_CHECK_NOTE
          ? "widened"
          : "enforced",
      matches: listsSubtree(snapshot.subtreeIds(id)),
      name: generatedName("sc", id),
      references: null,
      type: "c",
    },
    ...(parent === undefined
      ? []
      : [
          foreignKey(
            generatedName("lv", id),
            ["id", "class_id"],
            { columns: ["id", "class_id"], table: parent },
            { check: 2, deleteAction: "c", enforcement: "enforced" }
          ),
        ]),
    ...(parentId === null && users !== undefined
      ? [
          foreignKey(generatedName("cb", id), ["created_by"], auditTo, audit),
          foreignKey(generatedName("ub", id), ["updated_by"], auditTo, audit),
        ]
      : []),
  ];
};

const fieldConstraints = (
  snapshot: ConfigSnapshot,
  field: FieldDefinition
): readonly DescribedConstraint[] => {
  const { enforcement } = field;
  const constraints: DescribedConstraint[] = [];

  if (field.state === "active" && isNotNull(field)) {
    constraints.push({
      check: 3,
      columns: [field.name],
      deleteAction: null,
      enforcement,
      matches: always,
      name: generatedName("nn", field.id),
      references: null,
      type: "n",
    });
  }

  if (field.type.kind === "text") {
    constraints.push({
      check: 3,
      columns: [field.name],
      deleteAction: null,
      enforcement,
      matches: limitsLength(field.name, maxLengthOf(field.type)),
      name: generatedName("ck", field.id),
      references: null,
      type: "c",
    });
  }

  if (field.type.kind === "reference") {
    constraints.push(
      foreignKey(
        generatedName("fk", field.id),
        [field.name],
        {
          columns: ["id"],
          table: tableKeyOf(snapshot, field.type.targetClassId) ?? "",
        },
        { check: 3, deleteAction: "a", enforcement }
      )
    );
  }

  return constraints;
};

/**
 * Every constraint a standard class table should have, with its structure.
 *
 * @param snapshot - The configuration.
 * @param definition - The class.
 * @returns The constraints.
 */
export const describedConstraints = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): readonly DescribedConstraint[] => [
  ...classConstraints(snapshot, definition),
  ...snapshot
    .ownFields(definition.id)
    .flatMap((field) => fieldConstraints(snapshot, field)),
];

/**
 * Every index a standard class table should have: the indexes behind its
 * primary key and `(id, class_id)` key, and its live indexes.
 *
 * @param snapshot - The configuration.
 * @param definition - The class.
 * @returns The indexes.
 */
export const describedIndexes = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): readonly DescribedIndex[] => [
  {
    enforcement: "enforced",
    name: generatedName("pk", definition.id),
    unique: true,
  },
  {
    enforcement: "enforced",
    name: generatedName("uq", definition.id),
    unique: true,
  },
  ...snapshot.indexes(definition.id).map((index) => ({
    enforcement: index.enforcement,
    name: generatedName("ix", index.id),
    unique: index.unique,
  })),
];

/**
 * The triggers a class table has: the class-change trigger (Contracts 2.1),
 * and on `core.user` the trigger that ends a deactivated user's sessions.
 *
 * @param definition - The class.
 * @returns Their names.
 */
export const classTriggers = (
  definition: ClassDefinition
): readonly string[] => [
  generatedName("tg", definition.id),
  ...(definition.id === USER_CLASS_ID ? [SESSION_END_TRIGGER] : []),
];

const CREATE_TABLE =
  /^\s*CREATE TABLE (?<schema>[a-z_]+)\."?(?<table>[a-z_]+)"?/u;

/**
 * Tables the platform migrations create, by `schema.table`: described
 * platform tables and internal ones (ledger, config state, dependency
 * index, definition revisions, sessions, change entries).
 *
 * @returns Their keys.
 */
export const migrationTables = (): ReadonlySet<string> => {
  const keys = new Set<string>();

  for (const migration of PLATFORM_MIGRATIONS) {
    const statements = migration.kind === "tx" ? migration.statements : [];

    for (const statement of statements) {
      const groups = CREATE_TABLE.exec(statement)?.groups;

      if (groups?.schema !== undefined && groups.table !== undefined) {
        keys.add(tableKey(groups.schema, groups.table));
      }
    }
  }

  return keys;
};
