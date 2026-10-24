/** Shared list-order expressions for query, continuation and index keys. */
import { rawSql, sql } from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { isCaseSensitive } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";

/**
 * Whether a field's list order depends on the deployment language.
 * @param type - The field type.
 * @returns Whether the key uses ICU.
 */
export const hasLanguageOrder = (type: FieldType): boolean =>
  type.kind === "text" || type.kind === "longText" || type.kind === "choice";

/**
 * The same comparison key and collation used by list indexes and cursors.
 * @param type - The field type.
 * @param value - The masked value or indexed column.
 * @returns The SQL order key.
 */
export const listOrderKey = (
  type: FieldType,
  value: SqlFragment
): SqlFragment => {
  if (type.kind === "text" || type.kind === "longText") {
    const key = isCaseSensitive(type)
      ? value
      : sql`casefold(${value} COLLATE pg_unicode_fast)`;

    return sql`(${key} COLLATE core.list_order)`;
  }

  return type.kind === "choice"
    ? sql`(${value}${rawSql(" COLLATE core.list_order")})`
    : value;
};
