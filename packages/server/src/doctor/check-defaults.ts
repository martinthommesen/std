/**
 * `doctor` check 2, defaults: a column's default must equal its field's
 * constant default (Contracts 1.4: defaults are constants). Postgres keeps
 * a default in its own normalized form (`'abc'::text`, `false`, `1.50`), so
 * the expected constant and the stored expression are compared by value,
 * in SQL, cast to the column's type. Only stored expressions that are plain
 * constants are evaluated; anything else (a function call such as `now()`)
 * cannot be a field default and is reported without being run.
 */
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { liveColumn } from "./catalog-facts.ts";
import type { CatalogFacts } from "./catalog-facts.ts";
import { describedColumns, describedTables } from "./described.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

/** A string literal, optionally cast. */
const STRING_CONSTANT = /^'(?:[^']|'')*'(?:::[a-z][a-z0-9 _(),]*)?$/u;

/** A number, optionally cast. */
const NUMBER_CONSTANT = /^-?\d+(?:\.\d+)?(?:::[a-z][a-z0-9 _(),]*)?$/u;

/**
 * Whether a stored default is a plain constant.
 *
 * @param expression - `pg_get_expr` of the default.
 * @returns True for a literal, a number or a boolean.
 */
const isConstant = (expression: string): boolean =>
  expression === "true" ||
  expression === "false" ||
  STRING_CONSTANT.test(expression) ||
  NUMBER_CONSTANT.test(expression);

/** A column whose stored default is compared with the expected one. */
interface Comparison {
  readonly where: string;
  readonly type: string;
  readonly expected: string;
  readonly actual: string;
}

const decodeEqual = decodeRows(
  Schema.Struct({ equal: Schema.Boolean, ordinal: Schema.Int })
);

const mismatch = (comparison: Comparison): Finding =>
  finding(
    2,
    "error",
    "columnDefault",
    `Column ${comparison.where} has default ${comparison.actual}; its definition says ${comparison.expected}.`,
    comparison.where
  );

const comparisonsOf = (
  snapshot: ConfigSnapshot,
  catalog: CatalogFacts
): readonly Comparison[] =>
  describedTables(snapshot).flatMap((described) => {
    const facts = catalog.get(described.key);

    if (
      facts === undefined ||
      described.platform ||
      described.definition.state === "purged"
    ) {
      return [];
    }

    return describedColumns(snapshot, described).flatMap((expected) => {
      const column = liveColumn(facts, expected.name);

      const comparable =
        column !== undefined &&
        column.default !== null &&
        expected.default !== null;

      return !comparable || column.type !== expected.type
        ? []
        : [
            {
              actual: column.default,
              expected: expected.default,
              type: column.type,
              where: `${described.key}.${expected.name}`,
            },
          ];
    });
  });

/**
 * Compares stored defaults with the field defaults by value.
 *
 * @param snapshot - The configuration.
 * @param catalog - The catalog facts.
 * @returns The findings.
 */
export const checkDefaults = Effect.fn("Doctor.checkDefaults")(
  function* checkDefaults(
    snapshot: ConfigSnapshot,
    catalog: CatalogFacts
  ): Effect.fn.Return<readonly Finding[], SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const comparisons = comparisonsOf(snapshot, catalog);

    const statements = comparisons.flatMap((comparison, ordinal) =>
      isConstant(comparison.actual)
        ? [
            `SELECT ${ordinal} AS ordinal, (${comparison.expected})::${comparison.type} IS NOT DISTINCT FROM (${comparison.actual})::${comparison.type} AS equal`,
          ]
        : []
    );

    const results =
      statements.length === 0
        ? []
        : yield* readOnly(sql.unsafe(statements.join(" UNION ALL "))).pipe(
            Effect.flatMap(decodeEqual)
          );

    const equal = new Map(results.map((row) => [row.ordinal, row.equal]));

    return comparisons.flatMap((comparison, ordinal) =>
      equal.get(ordinal) === true ? [] : [mismatch(comparison)]
    );
  }
);
