/**
 * Proleptic Gregorian calendar arithmetic on whole days since 1970-01-01.
 *
 * Pure integer math (H. Hinnant's `days_from_civil`), independent of the
 * process time zone and of `Date`'s two-digit-year rules.
 */

/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;

const DAYS_PER_ERA = 146_097;
const YEARS_PER_ERA = 400;
const EPOCH_SHIFT = 719_468;
const MONTHS_PER_YEAR = 12;
const FEBRUARY = 2;
const MARCH_SHIFT = 9;
const MONTH_LENGTH_NUMERATOR = 153;
const MONTH_LENGTH_DENOMINATOR = 5;
const DAYS_PER_YEAR = 365;
const LEAP_EVERY = 4;
const NO_LEAP_EVERY = 100;
const DAYS_PER_4_YEARS = 1460;
const DAYS_PER_100_YEARS = 36_524;
const LAST_DAY_OF_ERA = 146_096;
const MONTHS_FROM_MARCH_TO_DECEMBER = 10;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** A calendar date split into its fields. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Whether a proleptic Gregorian year is a leap year.
 *
 * @param year - The year, 1 for AD 1.
 * @returns True for leap years.
 */
export const isLeapYear = (year: number): boolean =>
  year % LEAP_EVERY === 0 &&
  (year % NO_LEAP_EVERY !== 0 || year % YEARS_PER_ERA === 0);

/**
 * The number of days in a month.
 *
 * @param year - The year.
 * @param month - The month, 1 to 12.
 * @returns 28 to 31.
 */
export const daysInMonth = (year: number, month: number): number => {
  const days = MONTH_DAYS[month - 1] ?? 0;

  return month === FEBRUARY && isLeapYear(year) ? days + 1 : days;
};

/**
 * Whether year, month and day form a real calendar date.
 *
 * @param date - The fields to check.
 * @returns True when the month is 1 to 12 and the day exists in that month.
 */
export const isValidCivilDate = ({ year, month, day }: CivilDate): boolean => {
  const monthExists = month >= 1 && month <= MONTHS_PER_YEAR;

  return monthExists && day >= 1 && day <= daysInMonth(year, month);
};

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * @param date - A valid calendar date.
 * @returns The day number, negative before 1970.
 */
export const daysFromCivil = ({ year, month, day }: CivilDate): number => {
  const shiftedYear = month <= FEBRUARY ? year - 1 : year;
  const era = Math.floor(shiftedYear / YEARS_PER_ERA);
  const yearOfEra = shiftedYear - era * YEARS_PER_ERA;
  const monthFromMarch = (month + MARCH_SHIFT) % MONTHS_PER_YEAR;

  const dayOfYear =
    Math.floor(
      (MONTH_LENGTH_NUMERATOR * monthFromMarch + 2) / MONTH_LENGTH_DENOMINATOR
    ) +
    day -
    1;

  const dayOfEra =
    yearOfEra * DAYS_PER_YEAR +
    Math.floor(yearOfEra / LEAP_EVERY) -
    Math.floor(yearOfEra / NO_LEAP_EVERY) +
    dayOfYear;

  return era * DAYS_PER_ERA + dayOfEra - EPOCH_SHIFT;
};

/**
 * The proleptic Gregorian date of a day number.
 *
 * @param days - Days since 1970-01-01.
 * @returns The calendar date.
 */
export const civilFromDays = (days: number): CivilDate => {
  const shifted = days + EPOCH_SHIFT;
  const era = Math.floor(shifted / DAYS_PER_ERA);
  const dayOfEra = shifted - era * DAYS_PER_ERA;

  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / DAYS_PER_4_YEARS) +
      Math.floor(dayOfEra / DAYS_PER_100_YEARS) -
      Math.floor(dayOfEra / LAST_DAY_OF_ERA)) /
      DAYS_PER_YEAR
  );

  const dayOfYear =
    dayOfEra -
    (DAYS_PER_YEAR * yearOfEra +
      Math.floor(yearOfEra / LEAP_EVERY) -
      Math.floor(yearOfEra / NO_LEAP_EVERY));

  const monthFromMarch = Math.floor(
    (MONTH_LENGTH_DENOMINATOR * dayOfYear + 2) / MONTH_LENGTH_NUMERATOR
  );

  const day =
    dayOfYear -
    Math.floor(
      (MONTH_LENGTH_NUMERATOR * monthFromMarch + 2) / MONTH_LENGTH_DENOMINATOR
    ) +
    1;

  const month =
    monthFromMarch < MONTHS_FROM_MARCH_TO_DECEMBER
      ? monthFromMarch + 3
      : monthFromMarch - MARCH_SHIFT;

  const year = yearOfEra + era * YEARS_PER_ERA + (month <= FEBRUARY ? 1 : 0);

  return { day, month, year };
};

/**
 * Pads a non-negative integer with leading zeros.
 *
 * @param value - The integer.
 * @param width - The minimum number of digits.
 * @returns The padded decimal digits.
 */
export const padDigits = (value: number, width: number): string =>
  String(value).padStart(width, "0");

/**
 * Formats a date as `YYYY-MM-DD` for years 0 to 9999.
 *
 * @param date - The calendar date.
 * @returns The ISO 8601 calendar date.
 */
export const formatCivilDate = ({ year, month, day }: CivilDate): string =>
  `${padDigits(year, 4)}-${padDigits(month, 2)}-${padDigits(day, 2)}`;
