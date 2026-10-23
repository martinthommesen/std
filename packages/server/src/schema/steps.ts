/**
 * Follow-up step kinds (Contracts 1.5). Each kind defines a probe, which
 * reads the catalog and says whether the step's effect is `done`,
 * `not_started` or `partial`; the action; and the abandon action. The
 * coordinator runs the actions now; resume, abandon and the watchdog
 * (workstream 1A) use the probes and abandon actions.
 *
 * Steps run on the coordinator's dedicated connection in autocommit mode,
 * outside any transaction, with `lock_timeout = 0` and
 * `statement_timeout = 0`: a concurrent index build waits for older
 * transactions, and the watchdog, not a timeout, reports waits.
 */
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import { BACKFILL_STEP } from "./backfill.ts";
import { dropConstraint, dropIndexConcurrently } from "./ddl.ts";
import type { StepKind } from "./plan.ts";
import { detailText, unlimitedSession } from "./step-spec.ts";
import type { ProbeResult, StepRow, StepSpec } from "./step-spec.ts";

const decodeValid = decodeRows(Schema.Struct({ valid: Schema.Boolean }));

const decodeCount = decodeRows(Schema.Struct({ violations: Schema.String }));

const runStatement = (
  connection: DedicatedConnection,
  step: StepRow
): Effect.Effect<JsonObject, DatabaseError> =>
  unlimitedSession(connection).pipe(
    Effect.andThen(connection.execute(step.sql ?? "SELECT 1")),
    Effect.as({})
  );

const constraintProbe = (
  connection: DedicatedConnection,
  step: StepRow
): Effect.Effect<ProbeResult, DatabaseError> =>
  connection
    .execute(
      `SELECT convalidated AS valid FROM pg_constraint
       WHERE conrelid = to_regclass($1) AND conname = $2`,
      [detailText(step, "table"), detailText(step, "constraint")]
    )
    .pipe(
      Effect.flatMap(decodeValid),
      Effect.map(([row]) => {
        if (row === undefined) {
          return "partial";
        }

        return row.valid ? "done" : "not_started";
      })
    );

const indexProbe = (
  connection: DedicatedConnection,
  step: StepRow
): Effect.Effect<ProbeResult | "missing", DatabaseError> =>
  connection
    .execute(
      `SELECT i.indisvalid AS valid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [detailText(step, "schema"), detailText(step, "index")]
    )
    .pipe(
      Effect.flatMap(decodeValid),
      Effect.map(([row]) => {
        if (row === undefined) {
          return "missing";
        }

        return row.valid ? "done" : "partial";
      })
    );

const dropIndex = (
  connection: DedicatedConnection,
  step: StepRow
): Effect.Effect<void, DatabaseError> =>
  unlimitedSession(connection).pipe(
    Effect.andThen(
      connection.execute(
        dropIndexConcurrently(
          detailText(step, "definitionId"),
          detailText(step, "schema")
        ).sql
      )
    ),
    Effect.asVoid
  );

/** The step kinds that run as their own statements. */
export const STEP_SPECS: Readonly<
  Record<Exclude<StepKind, "complete">, StepSpec>
> = {
  backfill: BACKFILL_STEP,
  create_index_concurrently: {
    abandon: (connection, step) => ({
      autocommit: dropIndex(connection, step),
      complete: [],
    }),
    action: (connection, step) =>
      indexProbe(connection, step).pipe(
        Effect.flatMap((found) =>
          found === "partial" ? dropIndex(connection, step) : Effect.void
        ),
        Effect.andThen(runStatement(connection, step))
      ),
    probe: (connection, step) =>
      indexProbe(connection, step).pipe(
        Effect.map((found) => (found === "missing" ? "not_started" : found))
      ),
  },
  drop_index_concurrently: {
    // The index definition is already a tombstone, so abandoning the drop
    // finishes it; `IF EXISTS` and `CONCURRENTLY` also remove an index a
    // failed drop left invalid.
    abandon: (connection, step) => ({
      autocommit: dropIndex(connection, step),
      complete: [],
    }),
    action: runStatement,
    probe: (connection, step) =>
      indexProbe(connection, step).pipe(
        Effect.map((found) => (found === "missing" ? "done" : "not_started"))
      ),
  },
  validate_constraint: {
    abandon: (_, step) => ({
      autocommit: Effect.void,
      complete: [
        dropConstraint(
          detailText(step, "table"),
          detailText(step, "constraint"),
          detailText(step, "referencedTable") || null
        ),
      ],
    }),
    action: runStatement,
    probe: constraintProbe,
  },
  validate_override: {
    abandon: () => ({ autocommit: Effect.void, complete: [] }),
    action: (connection, step) =>
      connection.execute(step.sql ?? "SELECT '0' AS violations").pipe(
        Effect.flatMap(decodeCount),
        Effect.map(([row]): JsonObject => {
          const violations = Number(row?.violations ?? "0");

          return {
            outcome: violations === 0 ? "enforced" : "failed",
            violations,
          };
        })
      ),
    probe: (_, step) =>
      Effect.succeed(
        step.details.outcome === undefined ? "not_started" : "done"
      ),
  },
};
