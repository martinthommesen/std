/**
 * Field values between Postgres and `@std/values` for the write side.
 *
 * Reads select every field column as Postgres text (`col::text`, under the
 * session's `TimeZone=UTC` and `DateStyle=ISO`) and parse it with the
 * `@std/values` text parsers, so the record service never depends on the
 * driver's codecs. Password and secret columns are read only as "set or
 * not" (`col IS NOT NULL`), so a hash never leaves the database.
 *
 * Writes bind every value as a text parameter with the type's cast
 * (`$1::numeric`, Contracts 5.6); password plaintext is hashed before it
 * is bound.
 */
import type { FieldDefinition } from "@std/definitions/definition";
import { isIsoDate } from "@std/values/date";
import { isDecimal } from "@std/values/decimal";
import { ok, refuse } from "@std/values/field-error";
import type { Decoded } from "@std/values/field-error";
import { parameterCast } from "@std/values/field-type";
import type { FieldKind } from "@std/values/field-type";
import {
  isBigint,
  isBoolean,
  isNumber,
  isString,
} from "@std/values/field-value";
import type { DecodedInput, StoredValue } from "@std/values/field-value";
import { isJsonValue } from "@std/values/json-value";
import {
  dateParameter,
  int8Parameter,
  jsonbParameter,
  numericParameter,
  parseDateText,
  parseInt8Text,
  parseJsonbText,
  parseNumericText,
  parseTimestamptzText,
  timestamptzParameter,
} from "@std/values/postgres-text";
import { parseUuid } from "@std/values/uuid";
import { isPlaintext, secretState } from "@std/values/write-only";
import type { Plaintext } from "@std/values/write-only";

import { quoteIdent } from "../schema/sql-text.ts";

/**
 * Whether a kind is write-only (Contracts 4.3, 6.5): its value is never
 * read back, only whether it is set.
 *
 * @param kind - A field kind.
 * @returns True for password and secret.
 */
export const isWriteOnly = (kind: FieldKind): kind is "password" | "secret" =>
  kind === "password" || kind === "secret";

/**
 * The text expression that reads a field's column.
 *
 * @param field - The field.
 * @param alias - The table alias the column belongs to.
 * @returns `alias."col"::text`, or `(alias."col" IS NOT NULL)::text` for
 *   password and secret fields.
 */
export const columnText = (field: FieldDefinition, alias: string): string => {
  const column = `${alias}.${quoteIdent(field.name)}`;

  return isWriteOnly(field.type.kind)
    ? `(${column} IS NOT NULL)::text`
    : `${column}::text`;
};

const INTEGER_TEXT = /^-?\d+$/u;

const parseIntegerText = (text: string): Decoded<number> =>
  INTEGER_TEXT.test(text)
    ? ok(Number(text))
    : refuse("invalidFormat", "The stored integer is not an integer.");

const parseBooleanText = (text: string): Decoded<boolean> => {
  if (text === "true" || text === "false") {
    return ok(text === "true");
  }

  return refuse("invalidFormat", "The stored boolean is not a boolean.");
};

/**
 * Parses a column's text (see {@link columnText}) into the stored value of
 * its kind.
 *
 * @param kind - The field kind.
 * @param text - The column text.
 * @returns The stored value, or a refusal for text that is not of the kind
 *   (a defect in the caller or in the data).
 */
export const parseStoredText = (
  kind: FieldKind,
  text: string
): Decoded<StoredValue> => {
  switch (kind) {
    case "text":
    case "longText":
    case "choice": {
      return ok(text);
    }

    case "integer": {
      return parseIntegerText(text);
    }

    case "bigInteger": {
      return parseInt8Text(text);
    }

    case "decimal": {
      return parseNumericText(text);
    }

    case "boolean": {
      return parseBooleanText(text);
    }

    case "date": {
      return parseDateText(text);
    }

    case "dateTime": {
      return parseTimestamptzText(text);
    }

    case "reference":
    case "uuid": {
      return parseUuid(text);
    }

    case "password":
    case "secret": {
      const set = parseBooleanText(text);

      return set.ok ? ok(secretState(set.value)) : set;
    }

    case "json":
    case "condition": {
      return parseJsonbText(text);
    }

    default: {
      return kind satisfies never;
    }
  }
};

/** A bound parameter: its text (or null) and the cast after `$n`. */
export interface BoundValue {
  readonly text: string | null;
  readonly cast: string;
}

const mismatch = (kind: FieldKind): never => {
  throw new TypeError(`bindValue: the value is not a ${kind} input value.`);
};

type PresentInput = Exclude<DecodedInput, null | Plaintext>;

const bindString = (value: PresentInput): string | undefined =>
  isString(value) ? value : undefined;

const bindJson = (value: PresentInput): string | undefined =>
  isJsonValue(value) ? jsonbParameter(value) : undefined;

/** How each kind renders its parameter text; undefined for a mismatch. */
const BINDERS: Readonly<
  Record<
    Exclude<FieldKind, "password" | "secret">,
    (value: PresentInput) => string | undefined
  >
> = {
  bigInteger: (value) => (isBigint(value) ? int8Parameter(value) : undefined),
  boolean: (value) => (isBoolean(value) ? String(value) : undefined),
  choice: bindString,
  condition: bindJson,
  date: (value) =>
    isString(value) && isIsoDate(value) ? dateParameter(value) : undefined,
  dateTime: (value) =>
    isNumber(value) ? timestamptzParameter(value) : undefined,
  decimal: (value) => (isDecimal(value) ? numericParameter(value) : undefined),
  integer: (value) => (isNumber(value) ? String(value) : undefined),
  json: bindJson,
  longText: bindString,
  reference: bindString,
  text: bindString,
  uuid: bindString,
};

const bindPresent = (kind: FieldKind, value: PresentInput): string =>
  (isWriteOnly(kind) ? undefined : BINDERS[kind](value)) ?? mismatch(kind);

/**
 * Whether a non-null input value has the TypeScript shape of its kind
 * (plaintext for password and secret).
 *
 * @param kind - The field kind.
 * @param value - An input value, for example one a hook proposed.
 * @returns True when the value can be bound and encoded as that kind.
 */
export const isInputOfKind = (
  kind: FieldKind,
  value: Exclude<DecodedInput, null>
): boolean => {
  if (isWriteOnly(kind) || isPlaintext(value)) {
    return isWriteOnly(kind) && isPlaintext(value);
  }

  return BINDERS[kind](value) !== undefined;
};

/**
 * Binds a value for a write. Password and secret plaintext must be hashed
 * or encrypted first (see `WriteOnlyValues`) and passed as `hashed`.
 *
 * @param kind - The field kind.
 * @param value - The input value, or null to store NULL.
 * @param hashed - The hash or envelope text of a write-only value.
 * @returns The parameter text and its cast.
 */
export const bindValue = (
  kind: FieldKind,
  value: DecodedInput,
  hashed?: string
): BoundValue => {
  const cast = parameterCast(kind);

  if (value === null) {
    return { cast, text: null };
  }

  if (isPlaintext(value)) {
    return hashed !== undefined && isWriteOnly(kind)
      ? { cast, text: hashed }
      : mismatch(kind);
  }

  return { cast, text: bindPresent(kind, value) };
};
