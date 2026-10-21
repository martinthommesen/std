/**
 * Running statements built as `@std/conditions` SQL fragments: render the
 * placeholders once (`$1::numeric`, `$2::uuid[]`), bind every value as a
 * parameter, and decode the rows with a schema.
 */
import { renderSql } from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";

/** A row of text columns, as every read statement of the record service returns. */
export const TextRowSchema = Schema.Record(
  Schema.String,
  Schema.NullOr(Schema.String)
);

/** A row of text columns. */
export type TextRow = typeof TextRowSchema.Type;

const decodeTextRows = decodeRows(TextRowSchema);

/**
 * Runs a read statement and decodes its rows. The statement is marked
 * `readOnly`: it must be a plain `SELECT` that calls no writing function.
 *
 * @param fragment - The statement.
 * @returns The rows, every column as text or null.
 */
export const readRows = Effect.fn("Records.readRows")(function* readRows(
  fragment: SqlFragment
) {
  const sql = yield* SqlClient.SqlClient;
  const { text, values } = renderSql(fragment);
  const rows = yield* readOnly(sql.unsafe<object>(text, values));

  return yield* decodeTextRows(rows);
});

/**
 * Runs a writing statement (session rows, test fixtures) and decodes its
 * rows.
 *
 * @param fragment - The statement.
 * @returns The rows, every column as text or null.
 */
export const writeRows = Effect.fn("Records.writeRows")(function* writeRows(
  fragment: SqlFragment
) {
  const sql = yield* SqlClient.SqlClient;
  const { text, values } = renderSql(fragment);
  const rows = yield* sql.unsafe<object>(text, values);

  return yield* decodeTextRows(rows);
});
