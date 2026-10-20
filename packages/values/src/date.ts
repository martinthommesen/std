/**
 * Date values (Contracts 5.7, 6.5): `YYYY-MM-DD`, years 0001 to 9999,
 * proleptic Gregorian. A date is kept as its canonical string, whose order is
 * date order, so nothing here depends on the process time zone.
 */
import {
  civilFromDays,
  daysFromCivil,
  formatCivilDate,
  isValidCivilDate,
} from "./calendar.ts";
import type { CivilDate } from "./calendar.ts";
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

declare const isoDateBrand: unique symbol;

/** A canonical `YYYY-MM-DD` date between 0001-01-01 and 9999-12-31. */
export type IsoDate = string & { readonly [isoDateBrand]: "IsoDate" };

/** The first year a date may have. */
export const MIN_YEAR = 1;

/** The last year a date may have. */
export const MAX_YEAR = 9999;

const DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

// Only for text formatted from validated fields.
const hasDateForm = (text: string): text is IsoDate => DATE_PATTERN.test(text);

/**
 * Builds a date from its fields.
 *
 * @param date - Year, month and day.
 * @returns The canonical date, or `invalidDate` for a day that does not exist
 *   and `outOfRange` for a year outside 0001 to 9999.
 */
export const dateFromCivil = (date: CivilDate): Decoded<IsoDate> => {
  if (!isValidCivilDate(date)) {
    return refuse("invalidDate", "The date does not exist.");
  }

  if (date.year < MIN_YEAR || date.year > MAX_YEAR) {
    return refuse("outOfRange", "Dates must be in years 0001 to 9999.");
  }

  const text = formatCivilDate(date);

  return hasDateForm(text)
    ? ok(text)
    : refuse("outOfRange", "Dates must be in years 0001 to 9999.");
};

/**
 * Parses a `YYYY-MM-DD` date.
 *
 * @param input - The text to parse.
 * @returns The canonical date, or `invalidFormat`, `invalidDate` or
 *   `outOfRange`.
 */
export const parseDate = (input: string): Decoded<IsoDate> => {
  const groups = DATE_PATTERN.exec(input)?.groups;

  if (groups === undefined) {
    return refuse("invalidFormat", "Dates are written YYYY-MM-DD.");
  }

  return dateFromCivil({
    day: Number(groups.day),
    month: Number(groups.month),
    year: Number(groups.year),
  });
};

/**
 * Whether a string is a canonical date.
 *
 * @param input - The string to test.
 * @returns True for a valid `YYYY-MM-DD` date in range.
 */
export const isIsoDate = (input: string): input is IsoDate =>
  parseDate(input).ok;

/**
 * Splits a date into its fields.
 *
 * @param date - A canonical date.
 * @returns Year, month and day.
 */
export const dateToCivil = (date: IsoDate): CivilDate => ({
  day: Number(date.slice(8, 10)),
  month: Number(date.slice(5, 7)),
  year: Number(date.slice(0, 4)),
});

/**
 * Days since 1970-01-01.
 *
 * @param date - A canonical date.
 * @returns The day number.
 */
export const dateToEpochDay = (date: IsoDate): number =>
  daysFromCivil(dateToCivil(date));

/**
 * The date of a day number.
 *
 * @param epochDay - Days since 1970-01-01.
 * @returns The canonical date, or `outOfRange` outside 0001 to 9999.
 */
export const dateFromEpochDay = (epochDay: number): Decoded<IsoDate> =>
  dateFromCivil(civilFromDays(epochDay));

/**
 * Orders two dates.
 *
 * @param left - A canonical date.
 * @param right - A canonical date.
 * @returns Negative, zero or positive as left is before, equal to or after
 *   right.
 */
export const compareDates = (left: IsoDate, right: IsoDate): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};
