/**
 * Sorting and keyset cursors (Contracts 3.5).
 *
 * Every sort key is the field's masked expression (so a hidden value sorts
 * exactly like empty), text keys in code point order (`pg_unicode_fast`;
 * case-insensitive text by its `casefold` key). Ascending keys sort
 * `NULLS LAST`, descending ones `NULLS FIRST`, and `id` ascending breaks
 * ties.
 *
 * The cursor is opaque base64url JSON holding the sort's field IDs and
 * directions, each key's value as the text of its masked expression (or
 * null), and the last `id`. It carries nothing the caller could not read.
 * Its predicate is compiled in the expanded null-aware form over exactly
 * the expressions of `ORDER BY`, never as a row comparison
 * (`(k, id) > ($k, $id)` is NULL when k is NULL):
 *
 * ```sql
 *    (after(k1))
 * OR (eq(k1) AND after(k2))
 * OR (eq(k1) AND eq(k2) AND "r"."id" > $id)
 * ```
 *
 * with, for a stored value v: ascending `after(k) = (k > $v OR k IS NULL)`,
 * descending `after(k) = k < $v`, `eq(k) = k = $v`; and for an empty v:
 * ascending `after(k) = FALSE`, descending `after(k) = k IS NOT NULL`,
 * `eq(k) = k IS NULL`.
 */
import { InvalidCursor } from "@std/api/errors/invalid-cursor";
import {
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { isCaseSensitive, parameterCast } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import { checkInteger } from "@std/values/integer";
import {
  parseDateText,
  parseInt8Text,
  parseNumericText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { parseUuid } from "@std/values/uuid";
import { Effect, Schema } from "effect";

import type { SortKey } from "./read-query.ts";

/** A sort key compiled over masked expressions. */
export interface CompiledKey {
  readonly key: SortKey;
  /** The key expression, as used in `ORDER BY` and in the cursor predicate. */
  readonly expression: SqlFragment;
}

/** The position after the last row of a page. */
export interface CursorPosition {
  /** Key values as text, null for empty. */
  readonly values: readonly (string | null)[];
  readonly id: string;
}

const CursorSchema = Schema.Struct({
  i: Schema.String,
  k: Schema.Array(Schema.NullOr(Schema.String)),
  s: Schema.Array(Schema.String),
});

const decodeCursorJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CursorSchema)
);

const encodeCursorJson = Schema.encodeSync(Schema.fromJsonString(CursorSchema));

const COLLATION = rawSql(" COLLATE pg_unicode_fast");

/**
 * The sort expression of a field's masked expression.
 *
 * @param type - The field's type.
 * @param masked - The masked value expression.
 * @returns The key expression.
 */
export const keyExpression = (
  type: FieldType,
  masked: SqlFragment
): SqlFragment => {
  if (type.kind === "text" || type.kind === "longText") {
    return isCaseSensitive(type)
      ? sql`(${masked}${COLLATION})`
      : sql`(casefold(${masked}${COLLATION})${COLLATION})`;
  }

  return type.kind === "choice" ? sql`(${masked}${COLLATION})` : masked;
};

/**
 * `ORDER BY` for the keys, then `id`.
 *
 * @param keys - The compiled keys.
 * @param id - The `id` column.
 * @param reversed - Whether `id` sorts descending: with every key's
 *   direction flipped too, the exact reverse order (a `before` page).
 * @returns The order list.
 */
export const orderBy = (
  keys: readonly CompiledKey[],
  id: SqlFragment,
  reversed = false
): SqlFragment =>
  joinSql(
    [
      ...keys.map(({ expression, key }) =>
        key.descending
          ? sql`${expression} DESC NULLS FIRST`
          : sql`${expression} ASC NULLS LAST`
      ),
      reversed ? sql`${id} DESC` : sql`${id} ASC`,
    ],
    ", "
  );

const castOf = (type: FieldType): string =>
  type.kind === "choice" ? "text" : parameterCast(type.kind);

const after = (
  { expression, key }: CompiledKey,
  value: string | null
): SqlFragment | undefined => {
  if (value === null) {
    return key.descending ? sql`${expression} IS NOT NULL` : undefined;
  }

  const parameter = textParameter(value, castOf(key.field.type));

  return key.descending
    ? sql`${expression} < ${parameter}`
    : sql`(${expression} > ${parameter} OR ${expression} IS NULL)`;
};

const equal = ({ expression, key }: CompiledKey, value: string | null) =>
  value === null
    ? sql`${expression} IS NULL`
    : sql`${expression} = ${textParameter(value, castOf(key.field.type))}`;

/**
 * The keyset predicate: rows strictly after the position.
 *
 * @param keys - The compiled keys.
 * @param position - The cursor's values and id.
 * @param id - The `id` column.
 * @param reversed - Whether the order is reversed (`orderBy`'s
 *   `reversed`, keys flipped): then the rows strictly before it.
 * @param identityType - UUID record IDs or int8 delivery IDs.
 * @returns The predicate.
 */
export const cursorPredicate = (
  keys: readonly CompiledKey[],
  position: CursorPosition,
  id: SqlFragment,
  reversed = false,
  identityType: "uuid" | "int8" = "uuid"
): SqlFragment => {
  const disjuncts: SqlFragment[] = [];
  const beyond = rawSql(reversed ? "<" : ">");

  for (let index = 0; index <= keys.length; index += 1) {
    const prefix = keys
      .slice(0, index)
      .map((key, at) => equal(key, position.values[at] ?? null));

    const key = keys[index];

    const last =
      key === undefined
        ? sql`${id} ${beyond} ${textParameter(position.id, identityType)}`
        : after(key, position.values[index] ?? null);

    if (last !== undefined) {
      disjuncts.push(sql`(${joinSql([...prefix, last], " AND ")})`);
    }
  }

  return sql`(${joinSql(disjuncts, " OR ")})`;
};

/**
 * The cursor's signature of a sort: field IDs with `-` for descending.
 *
 * @param keys - The sort keys.
 * @returns The signature.
 */
export const sortSignature = (keys: readonly SortKey[]): string[] =>
  keys.map((key) => `${key.descending ? "-" : ""}${key.field.id}`);

/**
 * Encodes a cursor.
 *
 * @param keys - The sort keys.
 * @param position - The last row's key texts and id.
 * @returns Opaque base64url text.
 */
export const encodeCursor = (
  keys: readonly SortKey[],
  position: CursorPosition
): string =>
  Buffer.from(
    encodeCursorJson({
      i: position.id,
      k: [...position.values],
      s: sortSignature(keys),
    }),
    "utf-8"
  ).toString("base64url");

/**
 * Trims a fetched cursor page and builds its navigation cursors.
 * @param fetched - Text rows in the SQL query's order, including any lookahead row.
 * @param limit - The validated positive page limit.
 * @param reversed - Whether SQL read a before page in reverse order.
 * @param keys - Original sort keys, before reversal.
 * @returns Rows in display order and opaque navigation cursors.
 */
export const finishPage = <Row extends Readonly<Record<string, string | null>>>(
  fetched: readonly Row[],
  limit: number,
  reversed: boolean,
  keys: readonly SortKey[]
) => {
  const read = fetched.slice(0, limit);
  const rows = reversed ? read.toReversed() : read;
  const first = rows.at(0);
  const last = rows.at(-1);

  const hasMore = reversed
    ? last !== undefined
    : fetched.length > limit && last !== undefined;

  const cursorOf = (row: Row) =>
    encodeCursor(keys, {
      id: row.id ?? "",
      values: keys.map((_, index) => row[`k${index}`] ?? null),
    });

  return {
    firstCursor: first === undefined ? null : cursorOf(first),
    hasMore,
    nextCursor: last !== undefined && hasMore ? cursorOf(last) : null,
    rows,
  };
};

const INTEGER_TEXT = /^-?\d{1,10}$/u;

const validKeyText = (type: FieldType, text: string): boolean => {
  switch (type.kind) {
    case "integer": {
      return INTEGER_TEXT.test(text) && checkInteger(Number(text)).ok;
    }

    case "bigInteger": {
      return parseInt8Text(text).ok;
    }

    case "decimal": {
      return parseNumericText(text).ok;
    }

    case "boolean": {
      return text === "true" || text === "false";
    }

    case "date": {
      return parseDateText(text).ok;
    }

    case "dateTime": {
      return parseTimestamptzText(text).ok;
    }

    case "reference":
    case "uuid": {
      return parseUuid(text).ok;
    }

    case "text":
    case "longText":
    case "choice": {
      return !text.includes("\0");
    }

    case "password":
    case "secret":
    case "json":
    case "condition": {
      return false;
    }

    default: {
      return type satisfies never;
    }
  }
};

/**
 * Decodes a cursor issued for the same sort.
 *
 * @param keys - The request's sort keys.
 * @param text - The cursor parameter.
 * @param identityType - UUID record IDs or int8 delivery IDs.
 * @returns The position, or `InvalidCursor`.
 */
export const decodeCursor = Effect.fn("ReadCursor.decode")(
  function* decodeCursor(
    keys: readonly SortKey[],
    text: string,
    identityType: "uuid" | "int8" = "uuid"
  ) {
    const json = Buffer.from(text, "base64url").toString("utf-8");

    const cursor = yield* decodeCursorJson(json).pipe(
      Effect.mapError(() => new InvalidCursor())
    );

    const signature = sortSignature(keys);

    const sameSort =
      cursor.s.length === signature.length &&
      cursor.s.every((entry, index) => entry === signature[index]);

    const validValues =
      cursor.k.length === keys.length &&
      keys.every((key, index) => {
        const value = cursor.k[index];

        return (
          value === null ||
          value === undefined ||
          validKeyText(key.field.type, value)
        );
      });

    const validId =
      identityType === "uuid"
        ? parseUuid(cursor.i).ok
        : parseInt8Text(cursor.i).ok;

    if (!sameSort || !validValues || !validId) {
      return yield* new InvalidCursor();
    }

    return { id: cursor.i, values: cursor.k } satisfies CursorPosition;
  }
);
