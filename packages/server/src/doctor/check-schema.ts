/**
 * `doctor` checks that compare the definitions with `pg_catalog`
 * (Contracts 1.10 checks 2, 3, 4, 5, 11 and the catalog part of 12). They
 * read only the facts gathered once per run.
 */
import type {
  ClassDefinition,
  Enforcement,
  FieldDefinition,
} from "@std/definitions/definition";
import { generatedName, parseGeneratedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { isNotNull } from "../schema/ddl.ts";
import { WIDENED_CHECK_NOTE } from "../schema/plan.ts";
import type { CatalogFacts, TableFacts } from "./catalog-facts.ts";
import {
  classKeys,
  describedColumns,
  describedTables,
  migrationTables,
} from "./described.ts";
import type { DescribedTable } from "./described.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

/** Columns per table at which check 11 warns [judgment, Contracts 1.10]. */
export const COLUMN_HEADROOM_WARNING = 1400;

const isLiveClass = (described: DescribedTable): boolean =>
  described.definition.state !== "purged";

const columnFindings = (
  snapshot: ConfigSnapshot,
  described: DescribedTable,
  facts: TableFacts
): readonly Finding[] =>
  describedColumns(snapshot, described).flatMap((expected) => {
    const column = facts.columns.find(
      (entry) => entry.name === expected.name && !entry.dropped
    );

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

    const problems: Finding[] = [];

    if (expected.notNull !== null && column.notNull !== expected.notNull) {
      problems.push(
        finding(
          2,
          "error",
          "columnNullability",
          `Column ${where} is ${column.notNull ? "NOT NULL" : "nullable"}; its definition says ${expected.notNull ? "NOT NULL" : "nullable"}.`,
          where
        )
      );
    }

    if (
      expected.hasDefault !== null &&
      column.hasDefault !== expected.hasDefault
    ) {
      problems.push(
        finding(
          2,
          "error",
          "columnDefault",
          `Column ${where} ${column.hasDefault ? "has" : "has no"} default; its definition says it ${expected.hasDefault ? "has" : "has none"}.`,
          where
        )
      );
    }

    return problems;
  });

const keyFindings = (
  described: DescribedTable,
  facts: TableFacts
): readonly Finding[] => {
  const { constraints, trigger } = classKeys(described.definition);

  const missing = [
    ...constraints.filter(
      (name) => !facts.constraints.some((entry) => entry.name === name)
    ),
    ...(facts.triggers.includes(trigger) ? [] : [trigger]),
  ];

  return missing.map((name) =>
    finding(
      2,
      "error",
      "keyMissing",
      `Table ${described.key} lacks ${name} (key, level FK, subtree check or class-change trigger).`,
      `${described.key}/${name}`
    )
  );
};

/**
 * Check 2: every active and retired table and field matches the catalog.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkTablesMatch = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] =>
  describedTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (!isLiveClass(described)) {
      return [];
    }

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
      ...keyFindings(described, facts),
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

const fieldConstraintNames = (field: FieldDefinition): readonly string[] => [
  ...(isNotNull(field) ? [generatedName("nn", field.id)] : []),
  ...(field.type.kind === "text" ? [generatedName("ck", field.id)] : []),
  ...(field.type.kind === "reference" ? [generatedName("fk", field.id)] : []),
];

const constraintState = (
  facts: TableFacts,
  name: string
): "missing" | "invalid" | "valid" => {
  const found = facts.constraints.find((entry) => entry.name === name);

  if (found === undefined) {
    return "missing";
  }

  return found.validated ? "valid" : "invalid";
};

const subtreeFinding = (
  definition: ClassDefinition,
  key: string,
  facts: TableFacts
): readonly Finding[] => {
  const name = generatedName("sc", definition.id);
  const state = constraintState(facts, name);

  return state === "invalid" &&
    definition.enforcementNote !== WIDENED_CHECK_NOTE
    ? [enforcementFinding(key, name, state, "enforced")]
    : [];
};

/**
 * Check 3: every index and constraint exists under its ID-based name and is
 * valid, or its enforcement state explains why not; a widened subtree check
 * recorded with its note is accepted without VALIDATE.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkConstraintsValid = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] =>
  describedTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (facts === undefined || !isLiveClass(described) || described.platform) {
      return [];
    }

    const { definition, key } = described;

    const indexes = snapshot.indexes(definition.id).flatMap((index) => {
      const name = generatedName("ix", index.id);
      const found = facts.indexes.find((entry) => entry.name === name);

      if (found?.valid === true || index.state !== "active") {
        return [];
      }

      return [
        enforcementFinding(
          key,
          name,
          found === undefined ? "missing" : "invalid",
          index.enforcement
        ),
      ];
    });

    const fields = snapshot.ownFields(definition.id).flatMap((field) =>
      fieldConstraintNames(field).flatMap((name) => {
        const state = constraintState(facts, name);

        return state === "valid" || field.state !== "active"
          ? []
          : [enforcementFinding(key, name, state, field.enforcement)];
      })
    );

    const level =
      definition.parentId === null
        ? []
        : [generatedName("lv", definition.id)].flatMap((name) =>
            constraintState(facts, name) === "invalid"
              ? [enforcementFinding(key, name, "invalid", "enforced")]
              : []
          );

    return [
      ...indexes,
      ...fields,
      ...subtreeFinding(definition, key, facts),
      ...level,
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
): readonly Finding[] =>
  describedTables(snapshot).flatMap((described) => {
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

    const columns = snapshot
      .all("field")
      .flatMap((field) =>
        field.classId === described.definition.id &&
        field.state === "purged" &&
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

    const indexes = snapshot.all("index").flatMap((index) => {
      const name = generatedName("ix", index.id);

      return index.classId === described.definition.id &&
        index.state === "purged" &&
        facts.indexes.some((entry) => entry.name === name)
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
    });

    return [...columns, ...indexes];
  });

const expectedNames = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): ReadonlySet<string> =>
  new Set([
    ...classKeys(definition).constraints,
    generatedName("cb", definition.id),
    generatedName("ub", definition.id),
    ...snapshot
      .ownFields(definition.id)
      .flatMap((field) => fieldConstraintNames(field)),
    ...snapshot
      .indexes(definition.id)
      .map((index) => generatedName("ix", index.id)),
  ]);

const orphansOn = (
  snapshot: ConfigSnapshot,
  described: DescribedTable,
  facts: TableFacts
): readonly Finding[] => {
  const columns = new Set(
    describedColumns(snapshot, described).map((column) => column.name)
  );

  const names = expectedNames(snapshot, described.definition);
  const { key } = described;

  const orphanColumns = facts.columns.flatMap((column) =>
    column.dropped || columns.has(column.name)
      ? []
      : [
          finding(
            5,
            "warning",
            "orphanColumn",
            `Column ${key}.${column.name} is not described by any field (reported, never dropped).`,
            `${key}.${column.name}`
          ),
        ]
  );

  // Postgres names the NOT NULL constraints of system columns itself.
  const orphanConstraints = facts.constraints.flatMap((entry) =>
    names.has(entry.name) ||
    (entry.type === "n" && parseGeneratedName(entry.name) === undefined)
      ? []
      : [
          finding(
            5,
            "warning",
            "orphanConstraint",
            `Constraint ${entry.name} on ${key} belongs to no definition (reported, never dropped).`,
            `${key}/${entry.name}`
          ),
        ]
  );

  const orphanIndexes = facts.indexes.flatMap((entry) =>
    names.has(entry.name)
      ? []
      : [
          finding(
            5,
            "warning",
            "orphanIndex",
            `Index ${entry.name} on ${key} belongs to no definition (reported, never dropped).`,
            `${key}/${entry.name}`
          ),
        ]
  );

  return [...orphanColumns, ...orphanConstraints, ...orphanIndexes];
};

/**
 * Check 5: tables, columns, indexes and constraints in STD namespaces that
 * no definition describes. Reported, never dropped. Platform tables are
 * checked by their migrations (check 1) and only for orphan tables here.
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

  const internal = migrationTables();

  return [...catalog].flatMap(([key, facts]) => {
    const table = described.get(key);

    if (table === undefined) {
      return internal.has(key)
        ? []
        : [
            finding(
              5,
              "warning",
              "orphanTable",
              `Table ${key} is not described by any class (reported, never dropped).`,
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
 * except level FKs, which cascade deletes (Contracts 3.10).
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkInheritanceCatalog = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Finding[] => {
  const classTables = describedTables(snapshot).filter(isLiveClass);

  const nullable = classTables.flatMap((described) => {
    const column = catalog
      .get(described.key)
      ?.columns.find((entry) => entry.name === "class_id" && !entry.dropped);

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
      const expected = level ? CASCADE : NO_ACTION;

      const allowed =
        entry.deleteAction === expected && entry.updateAction === NO_ACTION;

      return entry.type !== "f" || allowed
        ? []
        : [
            finding(
              12,
              "error",
              "fkAction",
              `Foreign key ${entry.name} on ${key} has delete action ${entry.deleteAction} and update action ${entry.updateAction}; STD allows only NO ACTION, and CASCADE on level FKs.`,
              `${key}/${entry.name}`
            ),
          ];
    })
  );

  return [...nullable, ...actions];
};

/**
 * The tables of the schemas `doctor` inspects: every namespace's schema.
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
