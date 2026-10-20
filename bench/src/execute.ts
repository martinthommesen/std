/**
 * Runs compiled statements. Rows are decoded with a schema at this boundary
 * where their content is used; measured requests only count rows. On
 * failure, the statement text and parameters are logged so a broken
 * generated query can be found.
 */
import { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { BenchError } from "./errors.ts";
import type { Compiled } from "./sql-text.ts";

/** A schema for decoding rows that needs no services. */
export type RowSchema<A> = Schema.Codec<A, unknown>;

const logFailure = (statement: Compiled): Effect.Effect<void> =>
  Effect.logError(
    `statement failed: ${statement.text}\nparameters: ${JSON.stringify(statement.params)}`
  );

/**
 * Executes one statement as a prepared statement.
 *
 * @param statement - The SQL text and parameters.
 * @returns The undecoded rows.
 */
export const execute = (
  statement: Compiled
): Effect.Effect<readonly unknown[], SqlError, PgClient> =>
  Effect.gen(function* executeStatement() {
    const sql = yield* PgClient;

    const rows: readonly unknown[] = yield* sql.unsafe(
      statement.text,
      statement.params
    );

    return rows;
  }).pipe(Effect.tapError(() => logFailure(statement)));

/**
 * Decodes rows with a schema.
 *
 * @param schema - The row schema.
 * @param rows - The undecoded rows.
 * @returns The decoded rows.
 */
export const decodeRows = <A>(
  schema: RowSchema<A>,
  rows: readonly unknown[]
): Effect.Effect<readonly A[], BenchError> =>
  Schema.decodeEffect(Schema.Array(schema))(rows).pipe(
    Effect.mapError(
      (issue) =>
        new BenchError({ message: `unexpected row shape: ${issue.message}` })
    )
  );

/**
 * Executes one statement and decodes its rows.
 *
 * @param statement - The SQL text and parameters.
 * @param schema - The row schema.
 * @returns The decoded rows.
 */
export const query = <A>(
  statement: Compiled,
  schema: RowSchema<A>
): Effect.Effect<readonly A[], SqlError | BenchError, PgClient> =>
  Effect.flatMap(execute(statement), (rows) => decodeRows(schema, rows));

/** A row with a text `id`. */
export const IdRow = Schema.Struct({ id: Schema.String });

/** A row with a text `count`. */
export const CountRow = Schema.Struct({ count: Schema.String });
