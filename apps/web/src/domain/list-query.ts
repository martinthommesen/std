/**
 * What a list shows: its filter (a condition AST, fields by ID), its sort
 * keys (fields by ID) and its page size, and the two forms they take:
 *
 * - in the address (`/tables/:table?filter=&sort=&limit=`), by field ID,
 *   so a reload or a link survives renames (decision 0020);
 * - in the list request (`filter`, `sort`, `fields`, `limit`), by field
 *   name, as the API resolves them (Contracts 3.4, decision 0008): the
 *   filter printed with `@std/conditions/syntax-print`, the sort as
 *   comma-separated names with `-` for descending.
 */
import { ExprSchema } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import { printCondition } from "@std/conditions/syntax-print";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import type { FieldKind } from "@std/values/field-type";
import { Option, Result, Schema, pipe } from "effect";

import { fieldById, tableClassView } from "./table-view.ts";
import type { TablesByName } from "./table-view.ts";

/** One sort key: a field by ID, ascending or descending. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SortKey = Schema.Struct({
  fieldId: Schema.String,
  isDescending: Schema.Boolean,
});

/** One sort key. */
export type SortKey = typeof SortKey.Type;

/** The page sizes the list offers. */
export const PAGE_SIZES: readonly number[] = [5, 10, 25, 50, 100];

/** The page size of a list opened without one. [judgment] */
export const DEFAULT_PAGE_SIZE = 25;

/** The largest page the API returns (decision 0008). */
export const MAX_PAGE_SIZE = 1000;

/** What a list shows. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ListQuery = Schema.Struct({
  maybeCondition: Schema.Option(ExprSchema),
  pageSize: Schema.Int,
  sort: Schema.Array(SortKey),
});

/** What a list shows. */
export type ListQuery = typeof ListQuery.Type;

/** The list state the address carries, as text. */
export interface ListAddress {
  readonly filter: Option.Option<string>;
  readonly sort: Option.Option<string>;
  readonly limit: Option.Option<string>;
}

const UNSORTABLE: ReadonlySet<FieldKind> = new Set([
  "password",
  "secret",
  "json",
  "condition",
]);

/**
 * Whether the server sorts by a field (Contracts 3.5: not password,
 * secret, json or condition).
 *
 * @param field - The field.
 * @returns True when the list may be sorted by it.
 */
export const isSortable = (field: MetaField): boolean =>
  !UNSORTABLE.has(field.type.kind);

const PAGE_SIZE_TEXT = /^[1-9]\d{0,3}$/u;

/**
 * A page size from the address.
 *
 * @param maybeText - The `limit` parameter.
 * @returns The size, or the default when absent or out of range.
 */
export const pageSizeOf = (maybeText: Option.Option<string>): number =>
  Option.match(
    pipe(
      maybeText,
      Option.filter((text) => PAGE_SIZE_TEXT.test(text))
    ),
    {
      onNone: () => DEFAULT_PAGE_SIZE,
      onSome: (text) => Math.min(Number(text), MAX_PAGE_SIZE),
    }
  );

/**
 * The sort keys of the address that name sortable fields of the table;
 * others are dropped.
 *
 * @param maybeText - The `sort` parameter: field IDs, `-` for descending.
 * @param table - The table's metadata.
 * @returns The keys.
 */
export const sortKeysOf = (
  maybeText: Option.Option<string>,
  table: MetaTable
): readonly SortKey[] =>
  Option.match(maybeText, {
    onNone: () => [],
    onSome: (text) =>
      text
        .split(",")
        .map((item) => item.trim())
        .flatMap((item) => {
          const isDescending = item.startsWith("-");
          const fieldId = isDescending ? item.slice(1) : item;

          return Option.match(
            Option.filter(fieldById(table, fieldId), isSortable),
            {
              onNone: () => [],
              onSome: () => [{ fieldId, isDescending }],
            }
          );
        }),
  });

/**
 * The sort keys that still name sortable fields of the table, after its
 * definition changed; others are dropped, as {@link sortKeysOf} drops them
 * from an address.
 *
 * @param sort - The applied keys.
 * @param table - The table's current metadata.
 * @returns The keys kept, in order.
 */
export const reconcileSort = (
  sort: readonly SortKey[],
  table: MetaTable
): readonly SortKey[] =>
  sort.filter((key) =>
    Option.exists(fieldById(table, key.fieldId), isSortable)
  );

const decodeCondition = Schema.decodeUnknownOption(
  Schema.fromJsonString(ExprSchema)
);

/**
 * The filter of the address.
 *
 * @param maybeText - The `filter` parameter: the AST as JSON.
 * @returns The condition; a malformed parameter is none.
 */
export const conditionOf = (
  maybeText: Option.Option<string>
): Option.Option<Expr> => pipe(maybeText, Option.flatMap(decodeCondition));

/**
 * The address of a list state.
 *
 * @param query - The state.
 * @returns The `filter`, `sort` and `limit` parameters; defaults are left
 *   out.
 */
export const addressOf = (query: ListQuery): ListAddress => ({
  filter: pipe(
    query.maybeCondition,
    Option.map((condition) => JSON.stringify(condition))
  ),
  limit:
    query.pageSize === DEFAULT_PAGE_SIZE
      ? Option.none()
      : Option.some(String(query.pageSize)),
  sort:
    query.sort.length === 0
      ? Option.none()
      : Option.some(
          query.sort
            .map((key) => `${key.isDescending ? "-" : ""}${key.fieldId}`)
            .join(",")
        ),
});

const sameText = Option.makeEquivalence<string>((a, b) => a === b);

/**
 * Whether two addresses show the same list.
 *
 * @param left - One address.
 * @param right - The other.
 * @returns True when every parameter is equal.
 */
export const isSameAddress = (left: ListAddress, right: ListAddress): boolean =>
  sameText(left.filter, right.filter) &&
  sameText(left.sort, right.sort) &&
  sameText(left.limit, right.limit);

/**
 * The next sort after a click on a column header: ascending, then
 * descending, then the default order (by ID).
 *
 * @param sort - The current keys.
 * @param fieldId - The column's field.
 * @returns The new keys (one key at most).
 */
export const nextSort = (
  sort: readonly SortKey[],
  fieldId: string
): readonly SortKey[] => {
  const [current] = sort;

  if (current?.fieldId !== fieldId) {
    return [{ fieldId, isDescending: false }];
  }

  return current.isDescending ? [] : [{ fieldId, isDescending: true }];
};

/**
 * The list request's `sort` parameter: names, `-` for descending.
 *
 * @param sort - The keys.
 * @param table - The table's metadata.
 * @returns The parameter, or none for the default order.
 */
export const sortParameter = (
  sort: readonly SortKey[],
  table: MetaTable
): Option.Option<string> => {
  const names = sort.flatMap((key) =>
    Option.match(fieldById(table, key.fieldId), {
      onNone: () => [],
      onSome: (field) => [`${key.isDescending ? "-" : ""}${field.name}`],
    })
  );

  return names.length === 0 ? Option.none() : Option.some(names.join(","));
};

/**
 * The list request's `filter` parameter: the condition in the text syntax,
 * with field names.
 *
 * @param condition - The condition.
 * @param table - The table it applies to.
 * @param tables - The tables the browser holds (for paths).
 * @returns The text, or the printer's message when a field it names is no
 *   longer in the metadata.
 */
export const filterParameter = (
  condition: Expr,
  table: string,
  tables: TablesByName
): Result.Result<string, string> => {
  const printed = printCondition(condition, {
    classId: table,
    field: tableClassView(tables).field,
  });

  return printed.ok
    ? Result.succeed(printed.value)
    : Result.fail(
        printed.error.issues[0]?.message ?? "The filter does not print."
      );
};
