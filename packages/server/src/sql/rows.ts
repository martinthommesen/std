/**
 * Decoding driver rows with Effect Schema.
 *
 * The driver returns rows as plain objects keyed by column name. STD code
 * decodes them with a schema of the row instead of reading properties of an
 * untyped record. With STD's text reads (`text-codecs.ts`), `int8`,
 * `numeric`, dates and timestamps arrive as strings.
 */
import { Effect, Schema } from "effect";

/**
 * Builds a decoder for the rows of one query. A row that does not match is a
 * defect: the SQL and the schema disagree.
 * @param row - The schema of one row.
 * @returns A function from driver rows to decoded rows.
 */
export const decodeRows = <T>(
  row: Schema.Codec<T, unknown>
): ((rows: readonly unknown[]) => Effect.Effect<readonly T[]>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row));

  return (rows) => decode(rows).pipe(Effect.orDie);
};
