/**
 * One record's visibility and readable fields for a caller (Contracts 3.4,
 * 3.7, 3.9), decided by Postgres over the record's relation with the read
 * compiler's predicates: used by the save pipeline's existing-state check
 * and by history.
 */
import {
  identSql,
  joinSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import { Effect, Option } from "effect";

import { FALSE_SQL } from "./access-sql.ts";
import type { ReadScope } from "./read-view.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";

const ALIAS = "r";

/**
 * `CAST(COALESCE(e, false) AS text) AS "name"`: a predicate as `true` or
 * `false`, never null.
 *
 * @param expression - A boolean SQL expression.
 * @param name - The column alias.
 * @returns The select item.
 */
export const truthColumn = (
  expression: SqlFragment,
  name: string
): SqlFragment =>
  sql`CAST(COALESCE(${expression}, false) AS text) AS ${identSql(name)}`;

/**
 * Whether the caller sees a record of a known concrete class, and which of
 * the class's fields it can read on it (child-only fields included).
 *
 * @param scope - The caller's read scope.
 * @param classId - The record's concrete class.
 * @param id - The record ID.
 * @returns The readable field IDs, or none when the record is not visible
 *   (or has no row).
 */
export const readableOnRecord = Effect.fn("Records.readableOnRecord")(
  function* readableOnRecord(
    scope: ReadScope,
    classId: DefinitionId,
    id: string
  ) {
    const view = scope.view(classId, true);
    const fields = scope.snapshot.fields(classId);

    const columns = fields.map((field, index) => {
      const readField = view.byId(field.id);

      return truthColumn(
        readField === undefined ? FALSE_SQL : view.readable(ALIAS, readField),
        `f${index}`
      );
    });

    const [row] = yield* readRows(
      sql`SELECT ${joinSql([truthColumn(view.visibility(ALIAS), "visible"), ...columns], ", ")}
FROM ${recordRelation(scope.snapshot, classId)} AS ${identSql(ALIAS)}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(id, "uuid")}`
    );

    if (row?.visible !== "true") {
      return Option.none<ReadonlySet<DefinitionId>>();
    }

    const readable: ReadonlySet<DefinitionId> = new Set(
      fields.flatMap((field, index) =>
        row[`f${index}`] === "true" ? [field.id] : []
      )
    );

    return Option.some(readable);
  }
);
