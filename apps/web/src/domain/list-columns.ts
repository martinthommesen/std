/**
 * The columns of a table's list page and what each cell shows (Contracts
 * 6.3a, 6.6).
 *
 * Columns come from the table's list layout, which metadata serves with
 * only the fields the caller can read. Without one (or when the caller can
 * read none of its fields) the page uses its default selection [judgment,
 * decision 0020]: the display field first, then the other active fields in
 * metadata order, leaving out types that do not fit a cell (long text,
 * json, condition, password, secret), at most {@link DEFAULT_COLUMN_LIMIT}.
 *
 * A cell tells apart what the record JSON tells apart: a value, a stored
 * empty (`null`), a field withheld by an access rule on this record
 * (`withheld`: "restricted", never shown as empty), and a field the
 * response did not deliver (absent and not withheld).
 */
import type { RecordJson } from "@std/api/records";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import type { FieldKind } from "@std/values/field-type";
import {
  isJsonBoolean,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Option } from "effect";

/** The most columns the default selection shows. [judgment] */
export const DEFAULT_COLUMN_LIMIT = 6;

const NOT_IN_CELLS: ReadonlySet<FieldKind> = new Set([
  "longText",
  "json",
  "condition",
  "password",
  "secret",
]);

const layoutColumns = (table: MetaTable): readonly MetaField[] =>
  (table.layouts.list ?? []).flatMap((element) =>
    element.kind === "field"
      ? table.fields.filter((field) => field.id === element.fieldId)
      : []
  );

const defaultColumns = (table: MetaTable): readonly MetaField[] => {
  const display = table.fields.filter(
    (field) => field.name === table.displayField
  );

  const rest = table.fields.filter(
    (field) =>
      field.name !== table.displayField &&
      field.state === "active" &&
      !NOT_IN_CELLS.has(field.type.kind)
  );

  return [...display, ...rest].slice(0, DEFAULT_COLUMN_LIMIT);
};

/**
 * The columns of a table's list.
 *
 * @param table - The table's metadata.
 * @returns The fields to show, in order.
 */
export const listColumns = (table: MetaTable): readonly MetaField[] => {
  const fromLayout = layoutColumns(table);

  return fromLayout.length > 0 ? fromLayout : defaultColumns(table);
};

/**
 * The envelope member a list asks for when it has no column, so `fields`
 * is never empty (the server refuses `fields=`); the list then shows the
 * record's ID as its only column, linking to the record.
 */
export const ID_FIELD = "id";

/**
 * The list request's `fields` parameter: the columns' names, or `id` when
 * the table has no column to show (no display field, and only fields that
 * do not fit a cell) [judgment, decision 0020].
 *
 * @param table - The table's metadata.
 * @returns The parameter.
 */
export const listFieldsParameter = (table: MetaTable): string => {
  const names = listColumns(table).map((field) => field.name);

  return names.length > 0 ? names.join(",") : ID_FIELD;
};

/** What one cell shows. */
export type Cell =
  | { readonly _tag: "Shown"; readonly text: string }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Restricted" }
  | { readonly _tag: "NotDelivered" };

const MILLIS_SUFFIX = /\.000Z$/u;

/**
 * A date-time as the list shows it: the canonical UTC instant, readable.
 * The browser never converts to the device's zone (Contracts 5.7).
 *
 * @param instant - `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * @returns Such as `2026-10-22 08:15:30 UTC`.
 */
export const formatInstant = (instant: string): string =>
  `${instant.replace("T", " ").replace(MILLIS_SUFFIX, "").replace("Z", "")} UTC`;

const choiceLabel = (field: MetaField, key: string): string =>
  field.choices?.find((choice) => choice.key === key)?.label ?? key;

const MAX_JSON_TEXT = 80;

const shownText = (
  field: MetaField,
  value: JsonValue,
  maybeLabel: Option.Option<string>
): string => {
  const { kind } = field.type;

  if (kind === "choice" && isJsonString(value)) {
    return choiceLabel(field, value);
  }

  if (kind === "reference" && isJsonString(value)) {
    return Option.getOrElse(maybeLabel, () => value);
  }

  if (isJsonBoolean(value)) {
    return value ? "Yes" : "No";
  }

  if ((kind === "password" || kind === "secret") && isJsonObject(value)) {
    return value.set === true ? "Set" : "Not set";
  }

  if (kind === "dateTime" && isJsonString(value)) {
    return formatInstant(value);
  }

  if (isJsonString(value)) {
    return value;
  }

  const text = JSON.stringify(value);

  return text.length > MAX_JSON_TEXT
    ? `${text.slice(0, MAX_JSON_TEXT)}…`
    : text;
};

/**
 * What a record's cell for a field shows.
 *
 * @param record - The record as the list returned it.
 * @param field - The column's field.
 * @returns The cell.
 */
export const cellOf = (record: RecordJson, field: MetaField): Cell => {
  if (record.withheld?.includes(field.name) === true) {
    return { _tag: "Restricted" };
  }

  if (!Object.hasOwn(record.values, field.name)) {
    return { _tag: "NotDelivered" };
  }

  const value = record.values[field.name];

  if (value === null || value === undefined) {
    return { _tag: "Empty" };
  }

  return {
    _tag: "Shown",
    text: shownText(
      field,
      value,
      Option.fromNullishOr(record.labels?.[field.name])
    ),
  };
};
