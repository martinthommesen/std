/**
 * Platform tables (Contracts 1.9): created by platform migrations, described
 * by the core set so they appear in the API, verified by the loader and
 * never changed by it. Also the one bootstrap row the engine writes: the
 * system user, inserted in the change set that creates `core.user`.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { postgresColumn } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import type { StoredValue } from "@std/values/field-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { changedFields, writeChangeEntry } from "../records/change-entry.ts";
import { writeChangeImage } from "../records/change-image.ts";
import type { StoredRecord } from "../records/stored-record.ts";
import type { RequestRevision } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import type { CurrentTransaction } from "../sql/transaction-context.ts";
import { PlatformTableMismatch } from "./platform-table-mismatch.ts";
import { quoteIdent, tableName } from "./sql-text.ts";

/** System columns of a root class table: name, `format_type` and NOT NULL. */
const ROOT_COLUMNS: readonly (readonly [string, string])[] = [
  ["id", "uuid"],
  ["class_id", "uuid"],
  ["version", "bigint"],
  ["created_at", "timestamp(3) with time zone"],
  ["created_by", "uuid"],
  ["updated_at", "timestamp(3) with time zone"],
  ["updated_by", "uuid"],
];

const TIMESTAMP_TYPE = /^timestamptz\((?<precision>\d)\)$/u;

/**
 * The `format_type` text Postgres reports for a field type's column.
 *
 * @param type - A field type.
 * @returns For example `timestamp(3) with time zone` or `numeric(12,2)`.
 */
export const formatTypeOf = (type: FieldType): string => {
  const { sqlType } = postgresColumn(type);
  const precision = TIMESTAMP_TYPE.exec(sqlType)?.groups?.precision;

  return precision === undefined
    ? sqlType
    : `timestamp(${precision}) with time zone`;
};

const decodeColumns = decodeRows(
  Schema.Struct({
    name: Schema.String,
    not_null: Schema.Boolean,
    type: Schema.String,
  })
);

const columnProblems = (
  expected: ReadonlyMap<
    string,
    { readonly type: string; readonly notNull: boolean }
  >,
  actual: readonly {
    readonly name: string;
    readonly type: string;
    readonly not_null: boolean;
  }[]
): readonly string[] => {
  const found = new Map(actual.map((column) => [column.name, column]));
  const problems: string[] = [];

  for (const [name, spec] of expected) {
    const column = found.get(name);

    if (column === undefined) {
      problems.push(`column ${name} is missing`);
    } else if (column.type !== spec.type || column.not_null !== spec.notNull) {
      problems.push(
        `column ${name} is ${column.type}${column.not_null ? " NOT NULL" : ""}, described as ${spec.type}${spec.notNull ? " NOT NULL" : ""}`
      );
    }
  }

  for (const column of actual) {
    if (!expected.has(column.name)) {
      problems.push(`column ${column.name} is not described`);
    }
  }

  return problems;
};

/**
 * Checks that a platform table has exactly the described columns, types
 * and nullability. Reads only the catalog.
 *
 * @param snapshot - The configuration after the change set.
 * @param classId - A platform class.
 * @returns Fails with `PlatformTableMismatch` when they differ.
 */
export const verifyPlatformTable = Effect.fn("Schema.verifyPlatformTable")(
  function* verifyPlatformTable(
    snapshot: ConfigSnapshot,
    classId: DefinitionId
  ): Effect.fn.Return<
    void,
    PlatformTableMismatch | SqlError,
    SqlClient.SqlClient
  > {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* readOnly(
      sql`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               a.attnotnull AS not_null
        FROM pg_attribute a
        WHERE a.attrelid = to_regclass(${tableName(snapshot, classId)})
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`
    );

    const actual = yield* decodeColumns(rows);

    const expected = new Map<string, { type: string; notNull: boolean }>(
      ROOT_COLUMNS.map(([name, type]) => [name, { notNull: true, type }])
    );

    for (const field of snapshot.ownFields(classId)) {
      expected.set(field.name, {
        notNull: field.required || field.type.kind === "boolean",
        type: formatTypeOf(field.type),
      });
    }

    const problems =
      actual.length === 0
        ? ["the table does not exist"]
        : columnProblems(expected, actual);

    if (problems.length > 0) {
      return yield* new PlatformTableMismatch({ classId, problems });
    }

    return yield* Effect.void;
  }
);

/** The values of the system user's row, by field name. */
const SYSTEM_USER_VALUES: ReadonlyMap<string, string> = new Map([
  ["name", "'System'"],
  ["login", "'system'"],
  ["active", "false"],
]);

/** The system user's stored values, by field name; every other field is empty. */
const SYSTEM_USER_STORED: ReadonlyMap<string, StoredValue> = new Map<
  string,
  StoredValue
>([
  ["name", "System"],
  ["login", "system"],
  ["active", false],
]);

/**
 * The system user as a stored record of version 1, for its create entry.
 *
 * @param snapshot - The configuration after the change set.
 * @returns The record.
 */
const systemUserRecord = (snapshot: ConfigSnapshot): StoredRecord => ({
  classId: USER_CLASS_ID,
  createdAt: 0,
  createdBy: SYSTEM_USER_ID,
  id: SYSTEM_USER_ID,
  updatedAt: 0,
  updatedBy: SYSTEM_USER_ID,
  values: new Map(
    snapshot
      .fields(USER_CLASS_ID)
      .map((field) => [field.id, SYSTEM_USER_STORED.get(field.name) ?? null])
  ),
  version: 1,
});

/**
 * The `fields` of the system user's version-1 create entry: its fixed
 * values as a save of them would record them (`changedFields`).
 *
 * @param snapshot - The configuration.
 * @returns Field ID to `{ before, after }`.
 */
export const systemUserCreateFields = (snapshot: ConfigSnapshot): JsonObject =>
  changedFields({
    after: systemUserRecord(snapshot),
    before: null,
    classId: USER_CLASS_ID,
    snapshot,
    writeOnlySet: new Set(),
  });

/**
 * Inserts the system user into a `core.user` table created in this change
 * set, so audit columns and reference FKs to `core.user` have a target, and
 * writes its version-1 create entry with it, as a save would (Contracts
 * 4.2: one entry per version; review round 3 of decision 0023), so its
 * history starts with a complete create. Data migration 0016 writes the same
 * entry on installations whose system user predates this.
 *
 * @param snapshot - The configuration after the change set.
 * @param revision - The revision the main transaction commits.
 * @returns An effect in the main transaction.
 */
export const insertSystemUser = Effect.fn("Schema.insertSystemUser")(
  function* insertSystemUser(
    snapshot: ConfigSnapshot,
    revision: number
  ): Effect.fn.Return<
    void,
    SqlError,
    SqlClient.SqlClient | CurrentTransaction | RequestRevision
  > {
    const sql = yield* SqlClient.SqlClient;

    const values = snapshot.ownFields(USER_CLASS_ID).flatMap((field) => {
      const value = SYSTEM_USER_VALUES.get(field.name);

      return value === undefined
        ? []
        : [[quoteIdent(field.name), value] as const];
    });

    const columns = [
      "id, class_id, version, created_at, created_by, updated_at, updated_by",
      ...values.map(([column]) => column),
    ].join(", ");

    const literals = [
      "$1::uuid, $2::uuid, 1, now(), $1::uuid, now(), $1::uuid",
      ...values.map(([, value]) => value),
    ].join(", ");

    yield* sql.unsafe(
      `INSERT INTO ${tableName(snapshot, USER_CLASS_ID)} (${columns}) VALUES (${literals})`,
      [SYSTEM_USER_ID, USER_CLASS_ID]
    );

    const entry = yield* writeChangeEntry(
      {
        actorId: SYSTEM_USER_ID,
        cause: { kind: "system" },
        fields: systemUserCreateFields(snapshot),
        kind: "create",
        recordClassId: USER_CLASS_ID,
        recordId: SYSTEM_USER_ID,
        recordVersion: 1,
      },
      revision
    );

    yield* writeChangeImage(snapshot, entry, null, systemUserRecord(snapshot));
  }
);
