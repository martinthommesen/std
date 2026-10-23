/**
 * RFC 3339 §5.6 `date-time`, as OpenAPI's `format: date-time` means it
 * (`full-date "T" full-time`), with the calendar and time ranges of §5.7:
 * a month 01 to 12, a day that exists in that month (leap years by the
 * Gregorian rule), hours 00 to 23, minutes 00 to 59, seconds 00 to 59 (60
 * only for a leap second, at 23:59 UTC), an offset of at most 23:59, `T`
 * and `Z` in either case (§5.6 note).
 */

import { isValidCivilDate } from "@std/values/calendar";

const DATE_TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:(?<zulu>[Zz])|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY;
const LAST_MINUTE_OF_DAY = MINUTES_PER_DAY - 1;
const LEAP_SECOND = 60;

const between = (value: number, low: number, high: number): boolean =>
  value >= low && value <= high;

/**
 * Whether a text is an RFC 3339 `date-time` with valid calendar and time
 * values.
 *
 * @param text - The text.
 * @returns True when it is one.
 */
export const isRfc3339DateTime = (text: string): boolean => {
  const groups = DATE_TIME.exec(text)?.groups;

  if (groups === undefined) {
    return false;
  }

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second);
  const offsetHour = Number(groups.offsetHour ?? "0");
  const offsetMinute = Number(groups.offsetMinute ?? "0");

  const inRange = [
    isValidCivilDate({ day, month, year }),
    between(hour, 0, HOURS_PER_DAY - 1),
    between(minute, 0, MINUTES_PER_HOUR - 1),
    between(second, 0, LEAP_SECOND),
    between(offsetHour, 0, HOURS_PER_DAY - 1),
    between(offsetMinute, 0, MINUTES_PER_HOUR - 1),
  ].every(Boolean);

  if (!inRange) {
    return false;
  }

  if (second < LEAP_SECOND) {
    return true;
  }

  // A leap second is the last second of a UTC day.
  const offset =
    (groups.sign === "-" ? -1 : 1) *
    (offsetHour * MINUTES_PER_HOUR + offsetMinute);

  const utcMinute =
    (((hour * MINUTES_PER_HOUR + minute - offset) % MINUTES_PER_DAY) +
      MINUTES_PER_DAY) %
    MINUTES_PER_DAY;

  return utcMinute === LAST_MINUTE_OF_DAY;
};
