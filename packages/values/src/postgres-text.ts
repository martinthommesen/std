/**
 * Postgres text I/O (Contracts 5.6, 5.7). STD's SQL layer reads `numeric`,
 * `int8`, `date`, `timestamptz`, `json` and `jsonb` in Postgres's text form,
 * with the session at `TimeZone=UTC` and `DateStyle=ISO`, and binds values as
 * text parameters with casts (`$1::numeric`, see `parameterCast`).
 *
 * The parsers refuse what STD cannot represent: `NaN` and infinities, BC
 * dates, years past 9999 and sub-millisecond instants.
 */
import { daysFromCivil, isValidCivilDate, MS_PER_DAY } from "./calendar.ts";
import { formatDateTime, isnumber } from "./date-time.ts";
import { parseDate } from "./date.ts";
import type { IsoDate } from "./date.ts";
import { formatDecimal, makeDecimal } from "./decimal.ts";
import type { Decimal } from "./decimal.ts";
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";
import { formatBigInteger, parseBigInteger } from "./integer.ts";
import type { JsonValue } from "./json-value.ts";
import { parseJson, stringifyJson } from "./json.ts";

const NUMERIC_TEXT = /^(?<sign>-?)(?<integer>\d+)(?:\.(?<fraction>\d+))?$/u;

const TIMESTAMPTZ_TEXT =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,6}))?(?<sign>[+-])(?<offsetHour>\d{2})(?::(?<offsetMinute>\d{2}))?(?::(?<offsetSecond>\d{2}))?$/u;

const ZEROS = /^0*$/u;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MILLISECOND_DIGITS = 3;

const outOfRange = (what: string): Decoded<never> =>
  refuse("outOfRange", `The stored ${what} is outside what STD represents.`);

/**
 * Parses `numeric` output text.
 *
 * @param text - Text such as `-12.50`.
 * @returns The decimal at the scale written, or `outOfRange` for `NaN` and
 *   infinities, or `invalidFormat`.
 */
export const parseNumericText = (text: string): Decoded<Decimal> => {
  const groups = NUMERIC_TEXT.exec(text)?.groups;

  if (groups === undefined) {
    return text === "NaN" || text.endsWith("Infinity")
      ? outOfRange("numeric")
      : refuse("invalidFormat", "Unexpected numeric text.");
  }

  const fraction = groups.fraction ?? "";
  const magnitude = BigInt(`${groups.integer ?? ""}${fraction}`);

  return ok(
    makeDecimal(groups.sign === "-" ? -magnitude : magnitude, fraction.length)
  );
};

/**
 * Parses `int8` output text.
 *
 * @param text - Text such as `-9223372036854775808`.
 * @returns The bigint, or `invalidFormat`.
 */
export const parseInt8Text = (text: string): Decoded<bigint> =>
  parseBigInteger(text);

/**
 * Parses `date` output text under `DateStyle=ISO`.
 *
 * @param text - Text such as `2024-02-29`; BC dates end in ` BC`.
 * @returns The date, or `outOfRange` for BC dates, years past 9999 and
 *   infinities.
 */
export const parseDateText = (text: string): Decoded<IsoDate> => {
  const parsed = parseDate(text);

  return parsed.ok ? parsed : outOfRange("date");
};

const zoneOffset = (groups: Record<string, string | undefined>): number => {
  const magnitude =
    Number(groups.offsetHour) * MS_PER_HOUR +
    Number(groups.offsetMinute ?? "0") * MS_PER_MINUTE +
    Number(groups.offsetSecond ?? "0") * MS_PER_SECOND;

  return groups.sign === "-" ? -magnitude : magnitude;
};

/**
 * Parses `timestamptz` output text under `DateStyle=ISO`, normally with
 * `TimeZone=UTC` (offset `+00`); other offsets are applied.
 *
 * @param text - Text such as `2026-10-20 08:15:30.123+00`.
 * @returns Epoch milliseconds, or `outOfRange` (BC, past 9999, infinities),
 *   `subMillisecond` or `invalidFormat`.
 */
export const parseTimestamptzText = (text: string): Decoded<number> => {
  const groups = TIMESTAMPTZ_TEXT.exec(text)?.groups;

  if (groups === undefined) {
    return text.endsWith(" BC") ||
      text.endsWith("infinity") ||
      /^\d{5}/u.test(text)
      ? outOfRange("timestamptz")
      : refuse("invalidFormat", "Unexpected timestamptz text.");
  }

  const fraction = groups.fraction ?? "";

  if (!ZEROS.test(fraction.slice(MILLISECOND_DIGITS))) {
    return refuse(
      "subMillisecond",
      "The stored instant has sub-millisecond digits."
    );
  }

  const date = {
    day: Number(groups.day),
    month: Number(groups.month),
    year: Number(groups.year),
  };

  if (!isValidCivilDate(date)) {
    return refuse("invalidFormat", "Unexpected timestamptz text.");
  }

  const millis =
    daysFromCivil(date) * MS_PER_DAY +
    Number(groups.hour) * MS_PER_HOUR +
    Number(groups.minute) * MS_PER_MINUTE +
    Number(groups.second) * MS_PER_SECOND +
    Number(
      fraction.slice(0, MILLISECOND_DIGITS).padEnd(MILLISECOND_DIGITS, "0")
    ) -
    zoneOffset(groups);

  return isnumber(millis) ? ok(millis) : outOfRange("timestamptz");
};

/**
 * Parses `json` or `jsonb` output text under the json rules.
 *
 * @param text - The column text.
 * @returns The JSON value, or the refusal from `parseJson`.
 */
export const parseJsonbText = (text: string): Decoded<JsonValue> =>
  parseJson(text);

/**
 * Text for a `$n::numeric` parameter.
 *
 * @param value - The decimal.
 * @returns Its digits at its own scale.
 */
export const numericParameter = (value: Decimal): string =>
  formatDecimal(value);

/**
 * Text for a `$n::int8` parameter.
 *
 * @param value - The bigint.
 * @returns Its digits.
 */
export const int8Parameter = (value: bigint): string => formatBigInteger(value);

/**
 * Text for a `$n::date` parameter.
 *
 * @param value - The date.
 * @returns `YYYY-MM-DD`, which Postgres reads under any `DateStyle`.
 */
export const dateParameter = (value: IsoDate): string => value;

/**
 * Text for a `$n::timestamptz` parameter.
 *
 * @param value - Epoch milliseconds.
 * @returns ISO 8601 with `Z`, independent of the session time zone.
 */
export const timestamptzParameter = (value: number): string =>
  formatDateTime(value);

/**
 * Text for a `$n::jsonb` parameter.
 *
 * @param value - The JSON value.
 * @returns Canonical JSON text.
 */
export const jsonbParameter = (value: JsonValue): string =>
  stringifyJson(value);
