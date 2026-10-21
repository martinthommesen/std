/**
 * Plan-time data checks of a set upgrade (Contracts 8.4: a tightened
 * constraint violated by data is refused at plan time with counts). The
 * same checks the change set's preflight runs (`planChangeSet`'s
 * violations), counted read-only on `std upgrade`'s connection, which holds
 * `SCHEMA_KEY`, so no schema change runs meanwhile (Contracts 1.4).
 */
import type { AppliedChangeSet } from "@std/definitions/apply";
import type { DefinitionId } from "@std/definitions/ids";
import type { DataViolation } from "@std/definitions/upgrade-report";
import { Effect, Schema } from "effect";

import { SAMPLE_IDS } from "../schema/change-set.ts";
import { ASSUME_POPULATED, planChangeSet } from "../schema/plan.ts";
import { tableName } from "../schema/sql-text.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeCount = decodeRows(Schema.Struct({ n: Schema.String }));

const decodeIds = decodeRows(Schema.Struct({ id: Schema.String }));

const tableHasRows = Effect.fn("Config.tableHasRows")(function* tableHasRows(
  connection: DedicatedConnection,
  table: string
): Effect.fn.Return<boolean, DatabaseError> {
  const [exists] = yield* connection
    .execute("SELECT to_regclass($1) IS NOT NULL AS present", [table])
    .pipe(Effect.flatMap(decodePresence));

  if (exists?.present !== true) {
    return false;
  }

  const [row] = yield* connection
    .execute(`SELECT EXISTS (SELECT 1 FROM ${table}) AS present`)
    .pipe(Effect.flatMap(decodePresence));

  return row?.present === true;
});

/**
 * Counts the rows a set's change set would refuse.
 *
 * @param connection - `std upgrade`'s connection, holding `SCHEMA_KEY`.
 * @param applied - The set's operations applied in memory.
 * @returns One entry per violated tightening, with up to 20 sample IDs.
 */
export const countDataViolations = Effect.fn("Config.countDataViolations")(
  function* countDataViolations(
    connection: DedicatedConnection,
    applied: AppliedChangeSet
  ): Effect.fn.Return<readonly DataViolation[], DatabaseError> {
    const { existenceChecks } = planChangeSet(applied, ASSUME_POPULATED);
    const populated = new Set<DefinitionId>();

    yield* connection.execute("SET enable_seqscan = off");

    for (const classId of existenceChecks) {
      if (yield* tableHasRows(connection, tableName(applied.after, classId))) {
        populated.add(classId);
      }
    }

    yield* connection.execute("RESET enable_seqscan");

    const { violations } = planChangeSet(applied, {
      hasRows: (classId) => populated.has(classId),
    });

    const found: DataViolation[] = [];

    for (const check of violations) {
      const [counted] = yield* connection
        .execute(
          `SELECT count(*) AS n FROM ${check.table} WHERE ${check.predicate}`
        )
        .pipe(Effect.flatMap(decodeCount));

      const count = Number(counted?.n ?? "0");

      if (count > 0) {
        const samples = yield* connection
          .execute(
            `SELECT id::text AS id FROM ${check.table} WHERE ${check.predicate} ORDER BY id LIMIT ${SAMPLE_IDS}`
          )
          .pipe(Effect.flatMap(decodeIds));

        found.push({
          count,
          definitionId: check.definitionId,
          sampleIds: samples.map((row) => row.id),
        });
      }
    }

    return found;
  }
);
