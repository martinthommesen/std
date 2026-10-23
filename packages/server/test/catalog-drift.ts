/**
 * A small catalog check for schema-engine tests: does `pg_catalog` match
 * the definitions? Live standard tables and their columns exist with the
 * described type and nullability, purged ones are gone, every live index
 * exists under its generated name and is valid once `enforced`, dropped and
 * failed ones are gone.
 *
 * It covers what the lifecycle tests change. `std doctor` (workstream 1B)
 * checks much more; the interrupted-change test calls `catalogDrift` where
 * a `doctor` exit-0 assertion belongs too.
 */
import type {
  ClassDefinition,
  FieldDefinition,
} from "@std/definitions/definition";
import { generatedName } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../src/catalog/catalog.ts";
import { formatTypeOf } from "../src/schema/platform-tables.ts";
import { tableName } from "../src/schema/sql-text.ts";
import { decodeRows } from "../src/sql/rows.ts";

const SYSTEM_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

const decodeTables = decodeRows(
  Schema.Struct({
    columns: Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          not_null: Schema.Boolean,
          type: Schema.String,
        })
      )
    ),
    present: Schema.Boolean,
    table_name: Schema.String,
  })
);

const decodeIndexes = decodeRows(
  Schema.Struct({
    name: Schema.String,
    valid: Schema.NullOr(Schema.Boolean),
  })
);

const nullability = (notNull: boolean): string => (notNull ? " NOT NULL" : "");

const expectedNotNull = (field: FieldDefinition): boolean =>
  field.type.kind === "boolean" || (field.state === "active" && field.required);

const fieldDrift = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition,
  columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly not_null: boolean;
  }[]
): readonly string[] => {
  const table = tableName(snapshot, definition.id);
  const byName = new Map(columns.map((column) => [column.name, column]));
  const live = snapshot.ownFields(definition.id);
  const liveNames = new Set(live.map((field) => field.name));

  const missing = live.flatMap((field) => {
    const column = byName.get(field.name);

    if (column === undefined) {
      return [`${table}: column ${field.name} is missing`];
    }

    const type = formatTypeOf(field.type);
    const notNull = expectedNotNull(field);

    if (column.type === type && column.not_null === notNull) {
      return [];
    }

    const found = `${column.type}${nullability(column.not_null)}`;

    return [
      `${table}.${field.name} is ${found}, described as ${type}${nullability(notNull)}`,
    ];
  });

  const extra = columns.flatMap((column) =>
    SYSTEM_COLUMNS.has(column.name) || liveNames.has(column.name)
      ? []
      : [`${table}: column ${column.name} is not described`]
  );

  return [...missing, ...extra];
};

const indexDrift = Effect.fn("indexDrift")(function* indexDrift(
  sql: SqlClient.SqlClient,
  snapshot: ConfigSnapshot
) {
  const problems: string[] = [];

  const indexes = snapshot.all("index").flatMap((index) => {
    const owner = snapshot.class(index.classId);
    const namespace = snapshot.namespace(owner?.namespaceId ?? "");

    return owner?.storage === "standard" && namespace !== undefined
      ? [{ index, name: generatedName("ix", index.id), schema: namespace.name }]
      : [];
  });

  const rows = yield* sql
    .unsafe(
      `SELECT wanted.name, i.indisvalid AS valid
       FROM unnest($1::text[], $2::text[]) AS wanted(schema, name)
       LEFT JOIN pg_namespace n ON n.nspname = wanted.schema
       LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = wanted.name
       LEFT JOIN pg_index i ON i.indexrelid = c.oid`,
      [indexes.map((index) => index.schema), indexes.map((index) => index.name)]
    )
    .pipe(Effect.flatMap(decodeIndexes));

  const byName = new Map(rows.map((row) => [row.name, row.valid ?? undefined]));

  for (const { index, name } of indexes) {
    const valid = byName.get(name);

    const expected =
      index.state === "purged" || index.enforcement === "failed"
        ? "absent"
        : "valid";

    const validity = valid === true ? "valid" : "invalid";
    const actual = valid === undefined ? "absent" : validity;

    if (actual !== expected && index.enforcement !== "pending") {
      problems.push(`index ${name} is ${actual}, expected ${expected}`);
    }
  }

  return problems;
});

/**
 * Compares `pg_catalog` with the current definitions.
 *
 * @returns Every mismatch found; empty when the catalog matches.
 */
export const catalogDrift = Effect.gen(function* compareCatalog() {
  const snapshot = yield* (yield* Catalog).refresh;
  const sql = yield* SqlClient.SqlClient;
  const problems: string[] = [];

  const definitions = snapshot
    .all("class")
    .filter((definition) => definition.storage === "standard");

  const tables = yield* sql
    .unsafe(
      `SELECT wanted.table_name, wanted.relation IS NOT NULL AS present,
            coalesce(jsonb_agg(jsonb_build_object(
              'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull
            ) ORDER BY a.attnum) FILTER (WHERE a.attname IS NOT NULL), '[]'::jsonb) AS columns
       FROM (SELECT DISTINCT name AS table_name, to_regclass(name) AS relation FROM unnest($1::text[]) AS names(name)) AS wanted
       LEFT JOIN pg_attribute a ON a.attrelid = wanted.relation AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY wanted.table_name, wanted.relation`,
      [definitions.map((definition) => tableName(snapshot, definition.id))]
    )
    .pipe(Effect.flatMap(decodeTables));

  const byName = new Map(tables.map((table) => [table.table_name, table]));

  for (const definition of definitions) {
    const table = tableName(snapshot, definition.id);
    const actual = byName.get(table);

    if (definition.state === "purged") {
      if (actual?.present === true) {
        problems.push(`${table} is purged but exists`);
      }
    } else if (actual?.present === true) {
      problems.push(...fieldDrift(snapshot, definition, actual.columns));
    } else {
      problems.push(`${table} is missing`);
    }
  }

  problems.push(...(yield* indexDrift(sql, snapshot)));

  return problems;
});
