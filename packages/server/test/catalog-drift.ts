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

const decodeColumns = decodeRows(
  Schema.Struct({
    name: Schema.String,
    not_null: Schema.Boolean,
    type: Schema.String,
  })
);

const decodeExists = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeIndex = decodeRows(Schema.Struct({ valid: Schema.Boolean }));

const nullability = (notNull: boolean): string => (notNull ? " NOT NULL" : "");

const expectedNotNull = (field: FieldDefinition): boolean =>
  field.type.kind === "boolean" || (field.state === "active" && field.required);

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql.unsafe("SELECT to_regclass($1) IS NOT NULL AS present", [table]).pipe(
    Effect.flatMap(decodeExists),
    Effect.map(([row]) => row?.present === true)
  );

const columnsOf = (sql: SqlClient.SqlClient, table: string) =>
  sql
    .unsafe(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null
       FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
      [table]
    )
    .pipe(Effect.flatMap(decodeColumns));

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

const indexState = (sql: SqlClient.SqlClient, schema: string, name: string) =>
  sql
    .unsafe(
      `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name]
    )
    .pipe(
      Effect.flatMap(decodeIndex),
      Effect.map(([row]) => row?.valid)
    );

const indexDrift = Effect.fn("indexDrift")(function* indexDrift(
  sql: SqlClient.SqlClient,
  snapshot: ConfigSnapshot
) {
  const problems: string[] = [];

  for (const index of snapshot.all("index")) {
    const owner = snapshot.class(index.classId);
    const namespace = snapshot.namespace(owner?.namespaceId ?? "");

    if (owner?.storage === "standard" && namespace !== undefined) {
      const name = generatedName("ix", index.id);
      const valid = yield* indexState(sql, namespace.name, name);

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

  for (const definition of snapshot.all("class")) {
    if (definition.storage === "standard") {
      const table = tableName(snapshot, definition.id);
      const exists = yield* tableExists(sql, table);

      if (definition.state === "purged") {
        if (exists) {
          problems.push(`${table} is purged but exists`);
        }
      } else if (exists) {
        problems.push(
          ...fieldDrift(snapshot, definition, yield* columnsOf(sql, table))
        );
      } else {
        problems.push(`${table} is missing`);
      }
    }
  }

  problems.push(...(yield* indexDrift(sql, snapshot)));

  return problems;
});
