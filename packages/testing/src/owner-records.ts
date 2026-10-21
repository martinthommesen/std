/**
 * Inserting records directly, as table owner, for fixtures.
 *
 * TEMPORARY (workstream 0C reads): this bypasses the record service, so no
 * access check, no validation, no change entry and no outbox row. The
 * writes workstream replaces it with the save pipeline once that exists;
 * only the acme fixture and read tests use it.
 *
 * Each record gets one root row and one level row per class below the root,
 * in one statement per level, root first (Contracts 2.2 item 2).
 */
import { randomUUID } from "node:crypto";

import {
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import { writeRows } from "@std/server/records/sql-run";
import { tableName } from "@std/server/schema/sql-text";
import { parameterCast } from "@std/values/field-type";
import { Effect } from "effect";

/** One record to insert: field values as Postgres text, by field name. */
export interface OwnerRecord {
  /** A fixed ID, or a fresh UUID. */
  readonly id?: DefinitionId;
  /** The audit user (`created_by`, `updated_by`); default the system user. */
  readonly by?: DefinitionId;
  readonly values: Readonly<Record<string, string | null>>;
}

const parameter = (value: string, cast: string): SqlFragment =>
  sql`${textParameter(value, cast)}`;

const AUDIT = [
  "id",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
] as const;

/**
 * Inserts records of one concrete class as table owner.
 *
 * @param snapshot - The configuration.
 * @param classId - The concrete class.
 * @param records - The records.
 * @returns Their IDs, in order.
 */
export const insertAsOwner = Effect.fn("OwnerRecords.insert")(
  function* insertAsOwner(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    records: readonly OwnerRecord[]
  ) {
    const ids = records.map((record) => record.id ?? randomUUID());
    const lineage = snapshot.lineage(classId);

    for (const [depth, level] of lineage.entries()) {
      const fields = snapshot
        .ownFields(level.id)
        .filter((field) =>
          records.some((record) => field.name in record.values)
        );

      const columns = [
        ...(depth === 0 ? AUDIT : (["id", "class_id"] as const)),
        ...fields.map((field) => field.name),
      ].map((name) => identSql(name));

      const rows = records.map((record, index): SqlFragment => {
        const by = record.by ?? SYSTEM_USER_ID;
        const id = parameter(ids[index] ?? "", "uuid");
        const klass = parameter(classId, "uuid");

        const system =
          depth === 0
            ? [
                id,
                klass,
                rawSql("1"),
                rawSql("now()"),
                parameter(by, "uuid"),
                rawSql("now()"),
                parameter(by, "uuid"),
              ]
            : [id, klass];

        const values = fields.map((field) => {
          const value = record.values[field.name] ?? null;

          return value === null
            ? rawSql("NULL")
            : parameter(value, parameterCast(field.type.kind));
        });

        return sql`(${joinSql([...system, ...values], ", ")})`;
      });

      yield* writeRows(
        sql`INSERT INTO ${rawSql(tableName(snapshot, level.id))} (${joinSql(columns, ", ")}) VALUES ${joinSql(rows, ", ")}`
      );
    }

    return ids;
  }
);
