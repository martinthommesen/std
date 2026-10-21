/**
 * The expected catalog of the platform tables (Contracts 1.9): what the
 * platform migrations create, recorded from a freshly migrated database in
 * `platform-catalog.json` (columns with types, nullability and defaults;
 * constraints, indexes and triggers with their definitions and validity).
 * The ledger's checksums prove which migrations ran, not that their objects
 * are intact; `doctor` compares the live catalog with this record.
 *
 * The test `doctor-platform.test.ts` fails when the record and a freshly
 * migrated database differ; a new migration regenerates it with
 * `STD_WRITE_PLATFORM_CATALOG=1 pnpm --filter @std/server exec vitest run test/doctor-platform.test.ts`.
 */
import { Schema } from "effect";

import type { CatalogFacts, TableFacts } from "./catalog-facts.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";
import recorded from "./platform-catalog.json" with { type: "json" };

const ColumnSchema = Schema.Struct({
  default: Schema.NullOr(Schema.String),
  name: Schema.String,
  notNull: Schema.Boolean,
  type: Schema.String,
});

const ConstraintSchema = Schema.Struct({
  deferrable: Schema.Boolean,
  deferred: Schema.Boolean,
  definition: Schema.String,
  name: Schema.String,
  type: Schema.String,
  validated: Schema.Boolean,
});

const IndexSchema = Schema.Struct({
  definition: Schema.String,
  name: Schema.String,
  valid: Schema.Boolean,
});

const TriggerSchema = Schema.Struct({
  definition: Schema.String,
  name: Schema.String,
});

/** The expected catalog of one platform table. */
export const PlatformTableSchema = Schema.Struct({
  columns: Schema.Array(ColumnSchema),
  constraints: Schema.Array(ConstraintSchema),
  indexes: Schema.Array(IndexSchema),
  triggers: Schema.Array(TriggerSchema),
});

/** The expected catalog of one platform table. */
export type PlatformTable = typeof PlatformTableSchema.Type;

/** The expected catalog of every platform table, by `schema.table`. */
export const PlatformCatalogSchema = Schema.Record(
  Schema.String,
  PlatformTableSchema
);

/** The expected catalog of every platform table. */
export type PlatformCatalog = typeof PlatformCatalogSchema.Type;

/** The record committed with this version of STD. */
export const EXPECTED_PLATFORM_CATALOG: PlatformCatalog =
  Schema.decodeUnknownSync(PlatformCatalogSchema)(recorded);

const byName = <T extends { readonly name: string }>(
  entries: readonly T[]
): readonly T[] =>
  entries.toSorted((left, right) => (left.name < right.name ? -1 : 1));

/**
 * The catalog of one table in the recorded form.
 *
 * @param facts - The table's catalog facts.
 * @returns Its description.
 */
export const describeTable = (facts: TableFacts): PlatformTable => ({
  columns: facts.columns.flatMap((column) =>
    column.dropped
      ? []
      : [
          {
            default: column.default,
            name: column.name,
            notNull: column.notNull,
            type: column.type,
          },
        ]
  ),
  constraints: byName(
    facts.constraints.map((entry) => ({
      deferrable: entry.deferrable,
      deferred: entry.deferred,
      definition: entry.definition,
      name: entry.name,
      type: entry.type,
      validated: entry.validated,
    }))
  ),
  indexes: byName(
    facts.indexes.map((entry) => ({
      definition: entry.definition,
      name: entry.name,
      valid: entry.valid,
    }))
  ),
  triggers: byName(facts.triggers),
});

/**
 * The recorded form of the platform tables in a catalog.
 *
 * @param catalog - Catalog facts.
 * @param keys - The platform tables.
 * @returns Their descriptions, sorted by key.
 */
export const describePlatformTables = (
  catalog: CatalogFacts,
  keys: ReadonlySet<string>
): PlatformCatalog =>
  Object.fromEntries(
    [...keys].toSorted().flatMap((key) => {
      const facts = catalog.get(key);

      return facts === undefined ? [] : [[key, describeTable(facts)] as const];
    })
  );

/** How each kind of object maps to a check, code and severity. */
interface ObjectKind {
  readonly label: string;
  readonly missing: readonly [number, string];
  readonly changed: readonly [number, string];
  readonly extra: readonly [number, string];
}

const COLUMN: ObjectKind = {
  changed: [2, "columnMismatch"],
  extra: [5, "orphanColumn"],
  label: "column",
  missing: [2, "columnMissing"],
};

const CONSTRAINT: ObjectKind = {
  changed: [3, "constraintMismatch"],
  extra: [5, "orphanConstraint"],
  label: "constraint",
  missing: [3, "constraintMissing"],
};

const INDEX: ObjectKind = {
  changed: [3, "constraintMismatch"],
  extra: [5, "orphanIndex"],
  label: "index",
  missing: [3, "constraintMissing"],
};

const TRIGGER: ObjectKind = {
  changed: [2, "keyMismatch"],
  extra: [5, "orphanConstraint"],
  label: "trigger",
  missing: [2, "keyMissing"],
};

const compareObjects = <T extends { readonly name: string }>(
  key: string,
  kind: ObjectKind,
  expected: readonly T[],
  actual: readonly T[]
): readonly Finding[] => {
  const live = new Map(actual.map((entry) => [entry.name, entry]));
  const recordedNames = new Set(expected.map((entry) => entry.name));

  const differences = expected.flatMap((entry): Finding[] => {
    const found = live.get(entry.name);
    const subject = `${key}/${entry.name}`;

    if (found === undefined) {
      const [check, code] = kind.missing;

      return [
        finding(
          check,
          "error",
          code,
          `The platform ${kind.label} ${entry.name} of ${key} is missing.`,
          subject
        ),
      ];
    }

    const [check, code] = kind.changed;

    return JSON.stringify(found) === JSON.stringify(entry)
      ? []
      : [
          finding(
            check,
            "error",
            code,
            `The platform ${kind.label} ${entry.name} of ${key} differs from what its migration created: ${JSON.stringify(found)} instead of ${JSON.stringify(entry)}.`,
            subject
          ),
        ];
  });

  const extras = actual.flatMap((entry) => {
    const [check, code] = kind.extra;

    return recordedNames.has(entry.name)
      ? []
      : [
          finding(
            check,
            "warning",
            code,
            `The ${kind.label} ${entry.name} of ${key} was not created by a platform migration (reported, never dropped).`,
            `${key}/${entry.name}`
          ),
        ];
  });

  return [...differences, ...extras];
};

/**
 * Checks 2, 3 and 5 for platform tables: every table, column, constraint,
 * index and trigger the platform migrations create exists exactly as
 * recorded, and nothing else is on those tables.
 *
 * @param catalog - The live catalog facts.
 * @param expected - The recorded catalog (default: the committed record).
 * @returns The findings.
 */
export const checkPlatformTables = (
  catalog: CatalogFacts,
  expected: PlatformCatalog = EXPECTED_PLATFORM_CATALOG
): readonly Finding[] =>
  Object.entries(expected).flatMap(([key, table]): readonly Finding[] => {
    const facts = catalog.get(key);

    if (facts === undefined) {
      return [
        finding(
          2,
          "error",
          "tableMissing",
          `The platform table ${key} is missing.`,
          key
        ),
      ];
    }

    const live = describeTable(facts);

    return [
      ...compareObjects(key, COLUMN, table.columns, live.columns),
      ...compareObjects(key, CONSTRAINT, table.constraints, live.constraints),
      ...compareObjects(key, INDEX, table.indexes, live.indexes),
      ...compareObjects(key, TRIGGER, table.triggers, live.triggers),
    ];
  });
