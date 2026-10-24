/**
 * `doctor` checks that compare the definitions with `pg_catalog`
 * (Contracts 1.10 checks 2, 3, 4, 5, 11 and the catalog part of 12). They
 * read only the facts gathered once per run. Class tables are compared
 * with their definitions (`described.ts`), platform tables with the record
 * of what their migrations create (`platform-catalog.ts`).
 */
import type { Enforcement } from "@std/definitions/definition";
import { generatedName, parseGeneratedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { quoteIdent } from "../schema/sql-text.ts";
import { liveColumn } from "./catalog-facts.ts";
import type {
  CatalogFacts,
  ConstraintFact,
  TableFacts,
} from "./catalog-facts.ts";
import {
  classTriggers,
  describedColumns,
  describedConstraints,
  describedIndexes,
  describedTables,
  migrationTables,
} from "./described.ts";
import type {
  QuoteColumn,
  DescribedConstraint,
  DescribedIndex,
  DescribedTable,
} from "./described.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";
import { checkPlatformTables } from "./platform-catalog.ts";

/** Columns per table at which check 11 warns [judgment, Contracts 1.10]. */
export const COLUMN_HEADROOM_WARNING = 1400;

const isLiveClass = (described: DescribedTable): boolean =>
  described.definition.state !== "purged";

/**
 * Live standard class tables, which `described.ts` covers.
 *
 * @param snapshot - The configuration.
 * @returns The tables.
 */
const classTables = (snapshot: ConfigSnapshot): readonly DescribedTable[] =>
  describedTables(snapshot).filter(
    (described) => isLiveClass(described) && !described.platform
  );

const columnFindings = (
  snapshot: ConfigSnapshot,
  described: DescribedTable,
  facts: TableFacts
): readonly Finding[] =>
  describedColumns(snapshot, described).flatMap((expected) => {
    const column = liveColumn(facts, expected.name);

    const where = `${described.key}.${expected.name}`;

    if (column === undefined) {
      return [
        finding(
          2,
          "error",
          "columnMissing",
          `Column ${where} is missing.`,
          where
        ),
      ];
    }

    if (column.type !== expected.type) {
      return [
        finding(
          2,
          "error",
          "columnType",
          `Column ${where} is ${column.type}; its definition says ${expected.type}.`,
          where
        ),
      ];
    }

    if (expected.notNull !== null && column.notNull !== expected.notNull) {
      return [
        finding(
          2,
          "error",
          "columnNullability",
          `Column ${where} is ${column.notNull ? "NOT NULL" : "nullable"}; its definition says ${expected.notNull ? "NOT NULL" : "nullable"}.`,
          where
        ),
      ];
    }

    return (column.default === null) === (expected.default === null)
      ? []
      : [
          finding(
            2,
            "error",
            "columnDefault",
            `Column ${where} has default ${column.default ?? "none"}; its definition says ${expected.default ?? "none"}.`,
            where
          ),
        ];
  });

const enforcementFinding = (
  where: string,
  name: string,
  state: "missing" | "invalid",
  enforcement: Enforcement
): Finding => {
  const missing = state === "missing";
  const status = missing ? "missing" : "not valid";
  const subject = `${where}/${name}`;

  if (enforcement !== "enforced") {
    return finding(
      3,
      "info",
      "enforcementExplains",
      `${name} on ${where} is ${status}; enforcement ${enforcement} explains it.`,
      subject
    );
  }

  return finding(
    3,
    "error",
    missing ? "constraintMissing" : "constraintInvalid",
    `${name} on ${where} is ${status} although its definition is enforced.`,
    subject
  );
};

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.join(",") === right.join(",");

/**
 * How a live constraint differs in structure from its definition.
 *
 * @param expected - The described constraint.
 * @param actual - The live constraint.
 * @param quote - How Postgres prints each column.
 * @returns What differs, or an empty list.
 */
const structureDifferences = (
  expected: DescribedConstraint,
  actual: ConstraintFact,
  quote: QuoteColumn
): readonly string[] => {
  const { references } = expected;

  const referencesMatch =
    references === null ||
    (actual.references === references.table &&
      sameList(actual.referencedColumns, references.columns));

  const actionsMatch =
    expected.deleteAction === null ||
    (actual.deleteAction === expected.deleteAction &&
      actual.updateAction === "a");

  const differences = [
    actual.type === expected.type ? "" : `kind ${actual.type}`,
    sameList(actual.columns, expected.columns)
      ? ""
      : `columns (${actual.columns.join(", ")})`,
    referencesMatch
      ? ""
      : `references ${actual.references ?? "nothing"} (${actual.referencedColumns.join(", ")})`,
    actionsMatch ? "" : `actions ${actual.deleteAction}/${actual.updateAction}`,
    actual.deferrable ? "deferrable" : "",
    expected.matches(actual.definition, quote)
      ? ""
      : `definition ${actual.definition}`,
  ];

  return differences.filter((entry) => entry !== "");
};

/**
 * How Postgres prints a column of a table (`quote_ident`).
 *
 * @param facts - The table's catalog facts.
 * @param column - The column.
 * @returns The printed name; a column missing from the table is quoted.
 */
const quoteOf = (facts: TableFacts, column: string): string =>
  liveColumn(facts, column)?.quoted ?? quoteIdent(column);

const constraintFinding = (
  key: string,
  expected: DescribedConstraint,
  facts: TableFacts
): readonly Finding[] => {
  const actual = facts.constraints.find(
    (entry) => entry.name === expected.name
  );

  const subject = `${key}/${expected.name}`;

  if (actual === undefined) {
    return expected.check === 2
      ? [
          finding(
            2,
            "error",
            "keyMissing",
            `Table ${key} lacks ${expected.name} (key, level FK, subtree check or audit FK).`,
            subject
          ),
        ]
      : [
          enforcementFinding(
            key,
            expected.name,
            "missing",
            expected.enforcement === "widened"
              ? "enforced"
              : expected.enforcement
          ),
        ];
  }

  const differences = structureDifferences(expected, actual, (column) =>
    quoteOf(facts, column)
  );

  if (differences.length > 0) {
    return [
      finding(
        2,
        "error",
        "constraintMismatch",
        `${expected.name} on ${key} does not match its definition: ${differences.join("; ")}.`,
        subject
      ),
    ];
  }

  if (actual.validated || expected.enforcement === "widened") {
    return [];
  }

  return [
    enforcementFinding(key, expected.name, "invalid", expected.enforcement),
  ];
};

const indexFinding = (
  key: string,
  expected: DescribedIndex,
  facts: TableFacts
): readonly Finding[] => {
  const actual = facts.indexes.find((entry) => entry.name === expected.name);

  if (actual === undefined) {
    return [
      enforcementFinding(key, expected.name, "missing", expected.enforcement),
    ];
  }

  if (actual.unique !== expected.unique) {
    return [
      finding(
        2,
        "error",
        "constraintMismatch",
        `Index ${expected.name} on ${key} is ${actual.unique ? "" : "not "}unique; its definition says the opposite.`,
        `${key}/${expected.name}`
      ),
    ];
  }

  return actual.valid
    ? []
    : [enforcementFinding(key, expected.name, "invalid", expected.enforcement)];
};

/**
 * Check 2: every active and retired class table and field matches the
 * catalog (types, nullability, defaults, keys, level FK, audit FKs,
 * trigger), and the platform tables match their migrations.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkTablesMatch = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] => [
  ...classTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (facts === undefined) {
      return [
        finding(
          2,
          "error",
          "tableMissing",
          `Table ${described.key} is missing.`,
          described.key
        ),
      ];
    }

    return [
      ...columnFindings(snapshot, described, facts),
      ...classTriggers(described.definition).flatMap((trigger) =>
        facts.triggers.some((entry) => entry.name === trigger)
          ? []
          : [
              finding(
                2,
                "error",
                "keyMissing",
                `Table ${described.key} lacks its trigger ${trigger}.`,
                `${described.key}/${trigger}`
              ),
            ]
      ),
    ];
  }),
  ...checkPlatformTables(catalog),
];

/**
 * Checks 2 and 3 for class tables: every generated key, constraint and
 * index exists under its ID-based name with the structure its definition
 * implies, and is valid, or its enforcement state explains why not; a
 * widened subtree check recorded with its note is accepted without
 * VALIDATE.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkConstraintsValid = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] =>
  classTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (facts === undefined) {
      return [];
    }

    const { definition, key } = described;

    return [
      ...describedConstraints(snapshot, definition).flatMap((expected) =>
        constraintFinding(key, expected, facts)
      ),
      ...describedIndexes(snapshot, definition).flatMap((expected) =>
        indexFinding(key, expected, facts)
      ),
    ];
  });

/**
 * Check 4: purged definitions are absent from the catalog.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkPurgedAbsent = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] => {
  const fields = Map.groupBy(
    snapshot.all("field").filter((field) => field.state === "purged"),
    (field) => field.classId
  );

  const indexesByClass = Map.groupBy(
    snapshot.all("index").filter((index) => index.state === "purged"),
    (index) => index.classId
  );

  return describedTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (described.definition.state === "purged") {
      return facts === undefined
        ? []
        : [
            finding(
              4,
              "error",
              "purgedPresent",
              `Table ${described.key} belongs to a purged class but still exists.`,
              described.key
            ),
          ];
    }

    if (facts === undefined) {
      return [];
    }

    const columns = (fields.get(described.definition.id) ?? []).flatMap(
      (field) =>
        facts.columns.some(
          (column) => column.name === field.name && !column.dropped
        )
          ? [
              finding(
                4,
                "error",
                "purgedPresent",
                `Column ${described.key}.${field.name} belongs to a purged field but still exists.`,
                field.id
              ),
            ]
          : []
    );

    const indexes = (indexesByClass.get(described.definition.id) ?? []).flatMap(
      (index) => {
        const name = generatedName("ix", index.id);

        return facts.indexes.some((entry) => entry.name === name)
          ? [
              finding(
                4,
                "error",
                "purgedPresent",
                `Index ${name} belongs to a purged index but still exists.`,
                index.id
              ),
            ]
          : [];
      }
    );

    return [...columns, ...indexes];
  });
};

const orphan = (
  code: string,
  label: string,
  key: string,
  name: string
): Finding =>
  finding(
    5,
    "warning",
    code,
    `${label} ${name} on ${key} belongs to no definition (reported, never dropped).`,
    `${key}/${name}`
  );

const orphansOn = (
  snapshot: ConfigSnapshot,
  described: DescribedTable,
  facts: TableFacts
): readonly Finding[] => {
  const { definition, key } = described;

  const columns = new Set(
    describedColumns(snapshot, described).map((column) => column.name)
  );

  const constraints = new Set(
    describedConstraints(snapshot, definition).map((entry) => entry.name)
  );

  const indexes = new Set(
    describedIndexes(snapshot, definition).map((entry) => entry.name)
  );

  const triggers = new Set(classTriggers(definition));

  return [
    ...facts.columns.flatMap((column) =>
      column.dropped || columns.has(column.name)
        ? []
        : [orphan("orphanColumn", "Column", key, column.name)]
    ),
    // Postgres names the NOT NULL constraints of system columns itself.
    ...facts.constraints.flatMap((entry) =>
      constraints.has(entry.name) ||
      (entry.type === "n" && parseGeneratedName(entry.name) === undefined)
        ? []
        : [orphan("orphanConstraint", "Constraint", key, entry.name)]
    ),
    ...facts.indexes.flatMap((entry) =>
      indexes.has(entry.name)
        ? []
        : [orphan("orphanIndex", "Index", key, entry.name)]
    ),
    ...facts.triggers.flatMap((entry) =>
      triggers.has(entry.name)
        ? []
        : [orphan("orphanConstraint", "Trigger", key, entry.name)]
    ),
  ];
};

/**
 * Check 5: tables, columns, indexes, constraints and triggers in STD
 * namespaces that no definition or platform migration describes. Reported,
 * never dropped. (Objects on platform tables are compared with their
 * migrations' record in check 2.)
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkOrphans = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] => {
  const described = new Map(
    describedTables(snapshot).flatMap((entry) =>
      isLiveClass(entry) ? [[entry.key, entry] as const] : []
    )
  );

  const platform = migrationTables();

  return [...catalog].flatMap(([key, facts]) => {
    const table = described.get(key);

    if (platform.has(key)) {
      return [];
    }

    const inCore = key.startsWith("core.");

    if (table === undefined || (table.platform && inCore)) {
      return [
        finding(
          5,
          inCore ? "info" : "warning",
          inCore ? "newerPlatformTable" : "orphanTable",
          inCore
            ? `Platform table ${key} is newer than this release (reported, never dropped).`
            : `Table ${key} is not described by any class (reported, never dropped).`,
          key
        ),
      ];
    }

    return table.platform ? [] : orphansOn(snapshot, table, facts);
  });
};

/**
 * Check 11: column headroom per table, counting dropped columns, which
 * still count toward Postgres's 1,600-column limit.
 *
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkColumnHeadroom = (
  catalog: CatalogFacts
): readonly Finding[] =>
  [...catalog].flatMap(([key, facts]) =>
    facts.columns.length >= COLUMN_HEADROOM_WARNING
      ? [
          finding(
            11,
            "warning",
            "columnHeadroom",
            `Table ${key} has ${facts.columns.length} columns, dropped ones included; Postgres allows 1,600.`,
            key
          ),
        ]
      : []
  );

const LEVEL_FK_KIND = "lv";

/** `confdeltype`/`confupdtype` codes. */
const NO_ACTION = "a";

const CASCADE = "c";

/**
 * Check 12, catalog part: `class_id` is NOT NULL in every class table, and
 * every foreign key in STD schemas is `NO ACTION` on delete and update
 * except level FKs and the derived change image FK, which cascade deletes
 * (Contracts 3.10, 4.8; decision 0032).
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkInheritanceCatalog = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] => {
  const nullable = describedTables(snapshot).flatMap((described) => {
    if (!isLiveClass(described)) {
      return [];
    }

    const column = liveColumn(catalog.get(described.key), "class_id");

    return column !== undefined && !column.notNull
      ? [
          finding(
            12,
            "error",
            "classIdNullable",
            `Column ${described.key}.class_id is nullable; a NULL class_id would skip the level FK check.`,
            described.key
          ),
        ]
      : [];
  });

  const actions = [...catalog].flatMap(([key, facts]) =>
    facts.constraints.flatMap((entry) => {
      const level = parseGeneratedName(entry.name)?.kind === LEVEL_FK_KIND;

      const changeImage =
        key === "core.change_image" &&
        entry.name === "change_image_change_id_fkey";

      const expected = level || changeImage ? CASCADE : NO_ACTION;

      const allowed =
        entry.deleteAction === expected && entry.updateAction === NO_ACTION;

      return entry.type !== "f" || allowed
        ? []
        : [
            finding(
              12,
              "error",
              "fkAction",
              `Foreign key ${entry.name} on ${key} has delete action ${entry.deleteAction} and update action ${entry.updateAction}; STD requires NO ACTION, except CASCADE on level FKs and the derived change image FK.`,
              `${key}/${entry.name}`
            ),
          ];
    })
  );

  return [...nullable, ...actions];
};

/**
 * The schemas `doctor` inspects: `core` and every namespace's schema.
 *
 * @param snapshot - The configuration.
 * @returns Schema names.
 */
export const stdSchemas = (snapshot: ConfigSnapshot): readonly string[] =>
  [
    ...new Set([
      "core",
      ...snapshot
        .all("namespace")
        .flatMap((namespace) =>
          namespace.state === "purged" ? [] : [namespace.name]
        ),
    ]),
  ].toSorted();
