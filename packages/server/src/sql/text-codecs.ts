/**
 * Text reads for `numeric`, `int8`, `date`, `timestamp`, `timestamptz`,
 * `json` and `jsonb` (Contracts 5.6, 5.7).
 *
 * `@effect/sql-pg` 4.0.5 asks Postgres for every result column in the binary
 * format and has no text-format result path (`PgProtocol.ts`, `encodeBind`:
 * "One result format code, binary, for every column"). Its built-in codecs
 * turn `int8` into `bigint`, `timestamp`/`timestamptz` into `Date` (truncated
 * to milliseconds) and `json`/`jsonb` into parsed values. STD instead wants
 * the exact text Postgres would print, which `@std/values` parses itself.
 *
 * This module therefore registers binary codecs in a client `Registry` that
 * render each binary value as the string Postgres's own output function
 * produces with `DateStyle = ISO` and `TimeZone = UTC` (the STD session
 * settings). Arrays of these types use the same codecs for their elements.
 * Encoding is delegated to the driver's built-in codecs, so typed parameters
 * (`PgTypes.int8(1n)`, a `bigint` or `Date` parameter) keep working; STD's
 * generated SQL binds such values as text with a cast (`$1::numeric`).
 */
import { PgTypes } from "@effect/sql-pg";
import { civilFromDays } from "@std/values/calendar";
import type { CivilDate } from "@std/values/calendar";
import { Result } from "effect";

const MICROS_PER_SECOND = 1_000_000n;
const MICROS_PER_DAY = 86_400_000_000n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;
const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;

/** Days from 1970-01-01 to 2000-01-01, the Postgres date epoch. */
const PG_EPOCH_UNIX_DAYS = 10_957;
const NUMERIC_NEGATIVE = 0x40_00;
const NUMERIC_NAN = 0xc0_00;
const NUMERIC_POSITIVE_INFINITY = 0xd0_00;
const NUMERIC_NEGATIVE_INFINITY = 0xf0_00;
const NUMERIC_HEADER_BYTES = 8;
const NUMERIC_GROUP_DIGITS = 4;
const JSONB_VERSION = 1;
const MAX_DECIMAL_GROUP = 9999;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A binary value that does not have the layout of its type. */
class BinaryValueError extends Error {
  /**
   * @param message - What is wrong with the value.
   */
  constructor(message: string) {
    super(message);
    this.name = "BinaryValueError";
  }
}

const fail = (message: string): never => {
  throw new BinaryValueError(message);
};

/**
 * The digits of a fraction without trailing zeros.
 * @param digits - Fraction digits.
 * @returns The digits up to the last non-zero one.
 */
const trimTrailingZeros = (digits: string): string => {
  let end = digits.length;

  while (end > 0 && digits[end - 1] === "0") {
    end -= 1;
  }

  return digits.slice(0, end);
};

const view = (bytes: Uint8Array, offset: number, size: number): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, size);

const requireSize = (size: number, expected: number, type: string): void => {
  if (size !== expected) {
    fail(`Expected ${expected} bytes for ${type}, received ${size}`);
  }
};

const pad = (value: number | bigint, width: number): string =>
  String(value).padStart(width, "0");

/**
 * Floor division for bigints, rounding toward negative infinity.
 * @param value - The dividend.
 * @param divisor - A positive divisor.
 * @returns The floored quotient.
 */
const floorDiv = (value: bigint, divisor: bigint): bigint => {
  const quotient = value / divisor;

  return value % divisor < 0n ? quotient - 1n : quotient;
};

/** A formatted date and whether it needs the ` BC` suffix. */
interface FormattedDate {
  readonly text: string;
  readonly bc: boolean;
}

/**
 * Formats a date the way Postgres does with `DateStyle = ISO`: at least four
 * year digits, and years before 1 AD as `YYYY-MM-DD BC`.
 * @param date - An astronomical-year date.
 * @returns The text without the suffix, and whether it is BC.
 */
const formatCivilDate = (date: CivilDate): FormattedDate => {
  const bc = date.year <= 0;
  const year = bc ? 1 - date.year : date.year;

  return {
    bc,
    text: `${pad(year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`,
  };
};

/**
 * Renders a binary `date` (int32 days since 2000-01-01) as Postgres text.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns `YYYY-MM-DD`, `YYYY-MM-DD BC`, `infinity` or `-infinity`.
 */
export const readDate = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  requireSize(size, 4, "date");
  const days = view(bytes, offset, size).getInt32(0);

  if (days === INT32_MAX) {
    return "infinity";
  }

  if (days === INT32_MIN) {
    return "-infinity";
  }

  const { text, bc } = formatCivilDate(
    civilFromDays(days + PG_EPOCH_UNIX_DAYS)
  );

  return bc ? `${text} BC` : text;
};

const formatTimestamp = (micros: bigint, zoneSuffix: string): string => {
  if (micros === INT64_MAX) {
    return "infinity";
  }

  if (micros === INT64_MIN) {
    return "-infinity";
  }

  const days = floorDiv(micros, MICROS_PER_DAY);
  const timeOfDay = micros - days * MICROS_PER_DAY;
  const seconds = timeOfDay / MICROS_PER_SECOND;
  const fraction = timeOfDay % MICROS_PER_SECOND;
  const hours = seconds / SECONDS_PER_HOUR;
  const minutes = (seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE;
  const secs = seconds % SECONDS_PER_MINUTE;

  const fractionText =
    fraction === 0n ? "" : `.${trimTrailingZeros(pad(fraction, 6))}`;

  const { text, bc } = formatCivilDate(
    civilFromDays(Number(days) + PG_EPOCH_UNIX_DAYS)
  );

  const time = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${fractionText}`;

  return `${text} ${time}${zoneSuffix}${bc ? " BC" : ""}`;
};

/**
 * Renders a binary `timestamp` (int64 microseconds since 2000-01-01) as
 * Postgres text with `DateStyle = ISO`.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns For example `2026-10-20 12:34:56.789`.
 */
export const readTimestamp = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  requireSize(size, 8, "timestamp");

  return formatTimestamp(view(bytes, offset, size).getBigInt64(0), "");
};

/**
 * Renders a binary `timestamptz` as Postgres text with `DateStyle = ISO` and
 * `TimeZone = UTC`. The binary value is an absolute instant, so the result is
 * in UTC whatever the session's `TimeZone` is.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns For example `2026-10-20 12:34:56.789+00`.
 */
export const readTimestamptz = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  requireSize(size, 8, "timestamptz");

  return formatTimestamp(view(bytes, offset, size).getBigInt64(0), "+00");
};

/**
 * Renders a binary `int8` as its decimal text.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns For example `-9223372036854775808`.
 */
export const readInt8 = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  requireSize(size, 8, "int8");

  return view(bytes, offset, size).getBigInt64(0).toString();
};

/**
 * Renders a binary `numeric` the way Postgres's `numeric_out` does: the
 * integer part without leading zeros, then exactly `dscale` fraction digits.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns For example `-12.3400`, `NaN`, `Infinity` or `-Infinity`.
 */
export const readNumeric = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  if (size < NUMERIC_HEADER_BYTES) {
    return fail("Truncated numeric value");
  }

  const data = view(bytes, offset, size);
  const groups = data.getUint16(0);
  const weight = data.getInt16(2);
  const sign = data.getUint16(4);
  const scale = data.getUint16(6);

  if (sign === NUMERIC_NAN) {
    return "NaN";
  }

  if (sign === NUMERIC_POSITIVE_INFINITY) {
    return "Infinity";
  }

  if (sign === NUMERIC_NEGATIVE_INFINITY) {
    return "-Infinity";
  }

  if (sign !== 0 && sign !== NUMERIC_NEGATIVE) {
    return fail(`Invalid numeric sign ${sign}`);
  }

  requireSize(size, NUMERIC_HEADER_BYTES + groups * 2, "numeric");

  const group = (index: number): number => {
    if (index < 0 || index >= groups) {
      return 0;
    }

    const value = data.getInt16(NUMERIC_HEADER_BYTES + index * 2);

    return value >= 0 && value <= MAX_DECIMAL_GROUP
      ? value
      : fail(`Invalid numeric digit group ${value}`);
  };

  let integer = "";

  if (weight < 0) {
    integer = "0";
  } else {
    for (let index = 0; index <= weight; index += 1) {
      integer +=
        index === 0
          ? String(group(index))
          : pad(group(index), NUMERIC_GROUP_DIGITS);
    }
  }

  const fractionGroups = Math.ceil(scale / NUMERIC_GROUP_DIGITS);
  let fraction = "";

  for (let index = 0; index < fractionGroups; index += 1) {
    fraction += pad(group(weight + 1 + index), NUMERIC_GROUP_DIGITS);
  }

  const body = scale > 0 ? `${integer}.${fraction.slice(0, scale)}` : integer;

  return sign === NUMERIC_NEGATIVE ? `-${body}` : body;
};

/**
 * Returns the UTF-8 text of a binary `json` value, unparsed.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns The JSON text exactly as stored.
 */
export const readJson = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => utf8.decode(bytes.subarray(offset, offset + size));

/**
 * Returns the text of a binary `jsonb` value (a version byte followed by the
 * text `jsonb_out` prints), unparsed.
 * @param bytes - The buffer holding the value.
 * @param offset - Offset of the value in `bytes`.
 * @param size - Size of the value in bytes.
 * @returns The normalized JSON text Postgres prints for the value.
 */
export const readJsonb = (
  bytes: Uint8Array,
  offset: number,
  size: number
): string => {
  if (size === 0 || bytes[offset] !== JSONB_VERSION) {
    return fail("Unsupported jsonb version byte");
  }

  return utf8.decode(bytes.subarray(offset + 1, offset + size));
};

type Reader = (bytes: Uint8Array, offset: number, size: number) => string;

const guarded =
  (read: Reader) =>
  (
    bytes: Uint8Array,
    offset: number,
    size: number
  ): Result.Result<string, PgTypes.CodecError> => {
    try {
      return Result.succeed(read(bytes, offset, size));
    } catch (error) {
      return Result.fail(
        new PgTypes.CodecError({
          message:
            error instanceof Error ? error.message : "Invalid binary value",
        })
      );
    }
  };

const textCodec = (oid: number, read: Reader): PgTypes.Codec<unknown> => {
  const safeRead = guarded(read);

  // Values bound with a concrete type (a bigint, a Date, PgTypes.int8(...))
  // are encoded by the driver's built-in codec for the OID.
  return {
    decode: (bytes) => safeRead(bytes, 0, bytes.length),
    encode: (value) => PgTypes.encode(value, oid),
    read: safeRead,
  };
};

/** The OIDs that STD reads as text, with their readers. */
export const TEXT_READ_TYPES: readonly (readonly [
  name: string,
  oid: number,
  read: Reader,
])[] = [
  ["int8", PgTypes.OID.int8, readInt8],
  ["numeric", PgTypes.OID.numeric, readNumeric],
  ["date", PgTypes.OID.date, readDate],
  ["timestamp", PgTypes.OID.timestamp, readTimestamp],
  ["timestamptz", PgTypes.OID.timestamptz, readTimestamptz],
  ["json", PgTypes.OID.json, readJson],
  ["jsonb", PgTypes.OID.jsonb, readJsonb],
];

/**
 * Builds the client type registry STD uses for every connection: the driver's
 * built-in codecs, with the types in `TEXT_READ_TYPES` read as Postgres text.
 * The built-in array codecs look element codecs up in the registry, so arrays
 * of these types read as arrays of strings.
 * @returns A fresh registry to pass as the client's `types` option.
 */
export const makeTextRegistry = (): PgTypes.Registry => {
  const registry = PgTypes.makeRegistry();

  for (const [, oid, read] of TEXT_READ_TYPES) {
    registry.register(oid, textCodec(oid, read));
  }

  return registry;
};
