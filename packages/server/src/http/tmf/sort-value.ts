/** Compile a mapped textual value without exposing any unreadable source. */
import {
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { SortValue, SourceKey } from "@std/tmf/mapping";
import { TEXT_TRIM_CHARACTERS } from "@std/values/text";

/**
 * Compile the mapping's value algebra over masked sources.
 * @param value - The textual value projection.
 * @param source - The masked expression of a declared source.
 * @returns The derived SQL value, before language collation.
 */
export const compileSortValue = (
  value: SortValue,
  source: (key: SourceKey) => SqlFragment
): SqlFragment => {
  if ("source" in value) {
    return source(value.source);
  }

  if ("nonBlankSource" in value) {
    const expression = source(value.nonBlankSource);

    return sql`(CASE WHEN btrim(${expression}, ${textParameter(TEXT_TRIM_CHARACTERS, "text")}) = '' THEN NULL ELSE ${expression} END)`;
  }

  if ("value" in value) {
    return value.value === null
      ? rawSql("NULL::text")
      : sql`${textParameter(value.value, "text")}`;
  }

  if ("coalesce" in value) {
    return sql`COALESCE(${joinSql(
      value.coalesce.map((item) => compileSortValue(item, source)),
      ", "
    )})`;
  }

  if (value.cases.length === 0) {
    return compileSortValue(value.otherwise, source);
  }

  const branches = value.cases.map((branch) => {
    const predicates = Object.entries(branch.when).map(
      ([key, text]) =>
        sql`(${source(key)} COLLATE pg_unicode_fast) = ${textParameter(text, "text")}`
    );

    return sql`WHEN ${joinSql(predicates, " AND ")} THEN ${compileSortValue(branch.result, source)}`;
  });

  return sql`(CASE ${joinSql(branches, " ")} ELSE ${compileSortValue(value.otherwise, source)} END)`;
};
