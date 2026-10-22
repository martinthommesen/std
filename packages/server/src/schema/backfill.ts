import { stringifyJson } from "@std/values/json";
/**
 * The `backfill` follow-up step (Contracts 1.5, plan Step 2): numbers the
 * existing rows of a table that gains an auto-numbered field.
 *
 * The step runs on the coordinator's connection after the main commit,
 * outside `CONFIG_KEY`, like the other follow-up steps (nothing scans a
 * record table while `CONFIG_KEY` is held exclusively, 1.4). It works in
 * batches: each batch is one autocommit statement that locks up to
 * `BackfillBatchSize` rows whose column is still empty, in `id` order after
 * the stored keyset cursor (`FOR UPDATE`), takes a range of numbers per
 * prefix from `core.number_counter` (the counter saves use, so a backfilled
 * number never repeats one a save took), writes each row's number with the
 * effective prefix of its concrete class, and stores the new cursor in the
 * step's `details`, all in one transaction. A resumed step continues from
 * the cursor; a last sweep from the start numbers rows the cursor passed
 * (none, unless a table owner inserted rows behind it).
 *
 * Backfilled rows keep their version and get no change entry [judgment]:
 * the number is assigned as if the field had always had it, and no client
 * holding the record can have seen or written the field. Abandoning the
 * step keeps the numbers already assigned; a later create still numbers its
 * own record, and the rows left empty stay empty.
 */
import { isJsonObject, isJsonString } from "@std/values/json-value";
import { Context, Effect, Schema } from "effect";

import { NUMBER_DIGITS } from "../records/auto-numbers.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import { stepBoundary } from "./recovery-settings.ts";
import { detailText } from "./step-spec.ts";
import type { ProbeResult, StepRow, StepSpec } from "./step-spec.ts";

/** Rows per batch: 500 by default; tests make it small. */
export const BackfillBatchSize = Context.Reference<number>(
  "@std/server/schema/backfill/BackfillBatchSize",
  { defaultValue: () => 500 }
);

const decodeBatch = decodeRows(
  Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    rows: Schema.String,
  })
);

const decodeEmpty = decodeRows(Schema.Struct({ empty: Schema.Boolean }));

const prefixesOf = (step: StepRow): string => {
  const { prefixes } = step.details;

  return stringifyJson(
    prefixes !== undefined && isJsonObject(prefixes) ? prefixes : {}
  );
};

const cursorOf = (step: StepRow): string | null => {
  const { cursor } = step.details;

  return cursor !== undefined && isJsonString(cursor) ? cursor : null;
};

/**
 * One batch: lock, number and record the cursor in one statement.
 * Parameters: field ID, cursor (or null), batch size, fallback prefix,
 * prefixes by class ID (jsonb), step ID.
 *
 * @param table - The quoted table.
 * @param column - The quoted column.
 * @returns The statement.
 */
const batchStatement = (
  table: string,
  column: string
): string => `WITH batch AS (
  SELECT t.id, t.class_id FROM ${table} AS t
  WHERE t.${column} IS NULL AND ($2::uuid IS NULL OR t.id > $2::uuid)
  ORDER BY t.id LIMIT $3::int4 FOR UPDATE
), prefixed AS (
  SELECT b.id, coalesce(p.prefix, $4::text) AS prefix
  FROM batch AS b LEFT JOIN jsonb_each_text($5::jsonb) AS p (class_id, prefix) ON p.class_id::uuid = b.class_id
), numbered AS (
  SELECT id, prefix, row_number() OVER (PARTITION BY prefix ORDER BY id) AS k,
         count(*) OVER (PARTITION BY prefix) AS n
  FROM prefixed
), counts AS (
  SELECT DISTINCT prefix, n FROM numbered
), bumped AS (
  INSERT INTO core.number_counter AS counter (field_id, prefix, last_value)
  SELECT $1::uuid, prefix, n FROM counts
  ON CONFLICT (field_id, prefix) DO UPDATE SET last_value = counter.last_value + EXCLUDED.last_value
  RETURNING counter.prefix, counter.last_value
), assigned AS (
  UPDATE ${table} AS t
  SET ${column} = n.prefix || lpad((b.last_value - n.n + n.k)::text, greatest(${NUMBER_DIGITS}, length((b.last_value - n.n + n.k)::text)), '0')
  FROM numbered AS n JOIN bumped AS b ON b.prefix = n.prefix
  WHERE t.id = n.id
  RETURNING t.id
), progress AS (
  UPDATE core."schema_change_step"
  SET details = details || jsonb_build_object('cursor', (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1)),
      version = version + 1, updated_at = now()
  WHERE id = $6::uuid AND EXISTS (SELECT 1 FROM batch)
  RETURNING id
)
SELECT (SELECT count(*) FROM assigned)::text AS rows,
       (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS cursor`;

const unlimited = (connection: DedicatedConnection) =>
  Effect.andThen(
    connection.execute("SET lock_timeout = 0"),
    connection.execute("SET statement_timeout = 0")
  );

/**
 * Runs batches from a cursor until a batch finds no empty row.
 *
 * @param connection - The coordinator's connection.
 * @param step - The step.
 * @param start - The cursor to start after, or null for the beginning.
 * @returns How many rows it numbered.
 */
const sweep = Effect.fnUntraced(function* sweep(
  connection: DedicatedConnection,
  step: StepRow,
  start: string | null
): Effect.fn.Return<number, DatabaseError> {
  const batchSize = yield* BackfillBatchSize;

  const statement = batchStatement(
    detailText(step, "table"),
    detailText(step, "column")
  );

  let cursor = start;
  let total = 0;

  for (;;) {
    const [row] = yield* connection
      .execute(statement, [
        detailText(step, "definitionId"),
        cursor,
        String(batchSize),
        detailText(step, "prefix"),
        prefixesOf(step),
        step.id,
      ])
      .pipe(Effect.flatMap(decodeBatch));

    if (row === undefined || row.cursor === null) {
      return total;
    }

    total += Number(row.rows);
    ({ cursor } = row);
    yield* stepBoundary(`backfill:${step.ordinal}:batch`);
  }
});

const probe = (
  connection: DedicatedConnection,
  step: StepRow
): Effect.Effect<ProbeResult, DatabaseError> =>
  connection
    .execute(
      `SELECT NOT EXISTS (SELECT 1 FROM ${detailText(step, "table")} WHERE ${detailText(step, "column")} IS NULL) AS empty`
    )
    .pipe(
      Effect.flatMap(decodeEmpty),
      Effect.map(([row]): ProbeResult => {
        if (row?.empty !== false) {
          return "done";
        }

        return cursorOf(step) === null ? "not_started" : "partial";
      })
    );

/** The `backfill` step kind: probe, action and abandon action. */
export const BACKFILL_STEP: StepSpec = {
  // The numbers assigned so far stay; nothing physical to undo.
  abandon: () => Effect.void,
  action: (connection, step) =>
    Effect.gen(function* backfill() {
      yield* unlimited(connection);

      const resumed = yield* sweep(connection, step, cursorOf(step));
      const behind = yield* sweep(connection, step, null);

      return { numbered: resumed + behind };
    }),
  probe,
};
