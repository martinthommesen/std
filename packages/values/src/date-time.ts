/**
 * Date-time values (Contracts 5.7, 6.5): a UTC instant with millisecond
 * precision, kept as epoch milliseconds and written
 * `YYYY-MM-DDTHH:mm:ss.sssZ`. Input is RFC 3339 with `Z` or a numeric offset;
 * fraction digits past the third must be zero and leap seconds are refused.
 */
import {
  civilFromDays,
  daysFromCivil,
  formatCivilDate,
  isValidCivilDate,
  MS_PER_DAY,
  padDigits,
} from "./calendar.ts";
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const LEAP_SECOND = 60;
const MILLISECOND_DIGITS = 3;

/** The earliest date-time, 0001-01-01T00:00:00.000Z. */
export const MIN_DATE_TIME: number =
  daysFromCivil({ day: 1, month: 1, year: 1 }) * MS_PER_DAY;

/** The latest date-time, 9999-12-31T23:59:59.999Z. */
export const MAX_DATE_TIME: number =
  daysFromCivil({ day: 31, month: 12, year: 9999 }) * MS_PER_DAY +
  MS_PER_DAY -
  1;

const DATE_TIME_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d+))?(?:(?<utc>[Zz])|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;

const ZEROS = /^0*$/u;

/**
 * Whether a number is a date-time STD can hold.
 *
 * @param value - The candidate epoch milliseconds.
 * @returns True for whole milliseconds from 0001-01-01 to 9999-12-31 UTC.
 */
export const isnumber = (value: number): boolean =>
  Number.isInteger(value) && value >= MIN_DATE_TIME && value <= MAX_DATE_TIME;

const offsetMillis = (groups: Record<string, string | undefined>): number => {
  if (groups.utc !== undefined) {
    return 0;
  }

  const magnitude =
    Number(groups.offsetHour) * MS_PER_HOUR +
    Number(groups.offsetMinute) * MS_PER_MINUTE;

  return groups.sign === "-" ? -magnitude : magnitude;
};

const fieldsInRange = (groups: Record<string, string | undefined>): boolean => {
  const timeInRange =
    Number(groups.hour) <= MAX_HOUR && Number(groups.minute) <= MAX_MINUTE;

  const offsetInRange =
    groups.utc !== undefined ||
    (Number(groups.offsetHour) <= MAX_HOUR &&
      Number(groups.offsetMinute) <= MAX_MINUTE);

  return timeInRange && offsetInRange;
};

/**
 * Parses an RFC 3339 date-time into epoch milliseconds.
 *
 * @param input - Text such as `2026-10-20T10:15:30.123+02:00`.
 * @returns The instant, or `invalidDateTime`, `leapSecond`, `subMillisecond`
 *   or `outOfRange`.
 */
export const parseDateTime = (input: string): Decoded<number> => {
  const groups = DATE_TIME_PATTERN.exec(input)?.groups;

  if (groups === undefined) {
    return refuse(
      "invalidDateTime",
      "Date-times are RFC 3339, such as 2026-10-20T08:15:30.123Z."
    );
  }

  const fraction = groups.fraction ?? "";

  if (!ZEROS.test(fraction.slice(MILLISECOND_DIGITS))) {
    return refuse(
      "subMillisecond",
      "Date-times have millisecond precision; digits past the third must be zero."
    );
  }

  if (Number(groups.second) === LEAP_SECOND) {
    return refuse("leapSecond", "Leap seconds (:60) are not supported.");
  }

  const date = {
    day: Number(groups.day),
    month: Number(groups.month),
    year: Number(groups.year),
  };

  const valid =
    isValidCivilDate(date) &&
    fieldsInRange(groups) &&
    Number(groups.second) < LEAP_SECOND;

  if (!valid) {
    return refuse("invalidDateTime", "The date-time does not exist.");
  }

  const millis =
    daysFromCivil(date) * MS_PER_DAY +
    Number(groups.hour) * MS_PER_HOUR +
    Number(groups.minute) * MS_PER_MINUTE +
    Number(groups.second) * MS_PER_SECOND +
    Number(
      fraction.slice(0, MILLISECOND_DIGITS).padEnd(MILLISECOND_DIGITS, "0")
    ) -
    offsetMillis(groups);

  if (!isnumber(millis)) {
    return refuse(
      "outOfRange",
      "Date-times must be between 0001-01-01 and 9999-12-31 UTC."
    );
  }

  return ok(millis);
};

/**
 * Formats epoch milliseconds as the canonical `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * @param millis - An instant from 0001-01-01 to 9999-12-31 UTC.
 * @returns The canonical text.
 */
export const formatDateTime = (millis: number): string => {
  const days = Math.floor(millis / MS_PER_DAY);
  const ofDay = millis - days * MS_PER_DAY;
  const hour = Math.floor(ofDay / MS_PER_HOUR);
  const minute = Math.floor((ofDay % MS_PER_HOUR) / MS_PER_MINUTE);
  const second = Math.floor((ofDay % MS_PER_MINUTE) / MS_PER_SECOND);
  const milli = ofDay % MS_PER_SECOND;
  const time = `${padDigits(hour, 2)}:${padDigits(minute, 2)}:${padDigits(second, 2)}`;

  return `${formatCivilDate(civilFromDays(days))}T${time}.${padDigits(milli, MILLISECOND_DIGITS)}Z`;
};

/**
 * Orders two instants.
 *
 * @param left - Epoch milliseconds.
 * @param right - Epoch milliseconds.
 * @returns Negative, zero or positive.
 */
export const compareDateTimes = (left: number, right: number): number =>
  Math.sign(left - right);
