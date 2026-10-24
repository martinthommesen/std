/**
 * The relation of a class (Contracts 2.1, 2.3): one row per logical record
 * of subtree(T), assembled from its level tables, exposing every column by
 * name. Field names are unique per hierarchy and system names are reserved
 * (Contracts 1.1), so the names never collide.
 *
 * ```sql
 * (SELECT "t0"."id", "t0"."class_id", "t0"."version", <audit columns>,
 *         "t0"."name", ..., "t1"."serial", ..., "d0"."size_inches"
 *    FROM "acme"."asset" AS "t0"
 *    JOIN "acme"."laptop" AS "t1" ON "t1"."id" = "t0"."id"          -- T and its ancestors
 *    LEFT JOIN "acme"."monitor" AS "d0" ON "d0"."id" = "t0"."id")   -- descendants of T
 * ```
 *
 * The levels from the root down to T are inner joins, so a record whose
 * level row is missing is absent from T's endpoint (Contracts 2.2 item 2);
 * descendants are left joins, read only by access rules attached to them
 * and by reads of a concrete class. Postgres flattens the subquery and
 * removes left joins whose columns a statement does not use. Never
 * `SELECT *`: adding a column does not change any statement's row shape.
 */
import { identSql, joinSql, rawSql, sql } from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { tableName } from "../schema/sql-text.ts";

/** The root system columns every relation exposes. */
export const SYSTEM_COLUMNS = [
  "id",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
] as const;

interface Level {
  readonly classId: DefinitionId;
  readonly alias: string;
  readonly inner: boolean;
}

const levelsOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly Level[] => {
  const lineage = snapshot.lineage(classId).map((level, index) => ({
    alias: `t${index}`,
    classId: level.id,
    inner: true,
  }));

  const descendants = snapshot
    .subtree(classId)
    .slice(1)
    .map((level, index) => ({
      alias: `d${index}`,
      classId: level.id,
      inner: false,
    }));

  return [...lineage, ...descendants];
};

const relations = new WeakMap<ConfigSnapshot, Map<DefinitionId, SqlFragment>>();

/**
 * The relation of a class.
 *
 * @param snapshot - The configuration.
 * @param classId - The class T.
 * @returns A parenthesized subquery exposing `id`, `class_id`, `version`,
 *   the audit columns and every field column of T's lineage and subtree.
 */
export const recordRelation = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): SqlFragment => {
  const cached = relations.get(snapshot)?.get(classId);

  if (cached !== undefined) {
    return cached;
  }

  const levels = levelsOf(snapshot, classId);
  const [root, ...rest] = levels;

  if (root === undefined) {
    throw new RangeError(`Unknown class ${classId}`);
  }

  const columns = [
    ...SYSTEM_COLUMNS.map((name) => identSql(root.alias, name)),
    ...levels.flatMap((level) =>
      snapshot
        .ownFields(level.classId)
        .map((field) => identSql(level.alias, field.name))
    ),
  ];

  const joins = rest.map((level) => {
    const kind = level.inner ? "JOIN" : "LEFT JOIN";

    return sql`${rawSql(kind)} ${rawSql(tableName(snapshot, level.classId))} AS ${identSql(level.alias)} ON ${identSql(level.alias, "id")} = ${identSql(root.alias, "id")}`;
  });

  const from = sql`${rawSql(tableName(snapshot, root.classId))} AS ${identSql(root.alias)}`;

  const relation = sql`(SELECT ${joinSql(columns, ", ")} FROM ${joinSql([from, ...joins], " ")})`;
  let byClass = relations.get(snapshot);

  if (byClass === undefined) {
    byClass = new Map();
    relations.set(snapshot, byClass);
  }

  byClass.set(classId, relation);

  return relation;
};
