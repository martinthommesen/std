/**
 * Edge pools from Contracts 5 "Acceptance tests": the values most likely to
 * split TypeScript from Postgres. Stored values are in canonical JSON; text
 * candidates are raw and go through the write conversion before storage.
 */
import type { JsonValue } from "@std/values/json-value";

import { stableId } from "./schema.ts";

/** Raw single-line text candidates (converted before storage). */
export const TEXT_POOL: readonly string[] = [
  "ß",
  "ẞ",
  "ss",
  "SS",
  "Straße",
  "STRASSE",
  "strasse",
  "İ",
  "i",
  "ı",
  "I",
  "Σ",
  "σ",
  "ς",
  "ΣΑΣ",
  "ﬁ",
  "fi",
  "FI",
  "é",
  "é",
  "É",
  "𝔘",
  "𝔲",
  "😀",
  "👩‍👩‍👧",
  "%",
  "_",
  "\\",
  "a%b",
  "a_b",
  "a\\b",
  "  padded  ",
  "tab\tinside",
  " nbsp ",
  "x",
  "abc",
  "ABC",
  "Ab",
];

/** Extra raw long-text candidates. */
export const LONG_TEXT_EXTRA: readonly string[] = [
  "line1\nline2",
  "a\r\nb",
  "a\rb",
  "  indented\n",
];

/** Needles for the pattern operators (`""` is valid except for contains). */
export const NEEDLE_POOL: readonly string[] = [
  "s",
  "ss",
  "S",
  "ß",
  "ẞ",
  "i",
  "İ",
  "ı",
  "σ",
  "Σ",
  "ﬁ",
  "fi",
  "%",
  "_",
  "\\",
  "a",
  "b",
  "é",
  "😀",
  "‍",
  " ",
  "\t",
  "line",
  "\n",
  "",
];

/** int4 edge values. */
export const INTEGER_POOL: readonly number[] = [
  -2_147_483_648, 2_147_483_647, -1, 0, 1, 2, 42, -42,
];

/** int8 edge values as canonical strings. */
export const BIG_INTEGER_POOL: readonly string[] = [
  "-9223372036854775808",
  "9223372036854775807",
  "9007199254740991",
  "9007199254740992",
  "9007199254740993",
  "-9007199254740991",
  "-9007199254740992",
  "-9007199254740993",
  "0",
  "1",
  "-1",
  "42",
];

/** numeric(38, 6) edge values at the field's scale. */
export const DECIMAL_POOL: readonly string[] = [
  "99999999999999999999999999999999.999999",
  "-99999999999999999999999999999999.999999",
  "0.000000",
  "0.000001",
  "-0.000001",
  "1.500000",
  "-1.500000",
  "42.000000",
  "1.000000",
  "9007199254740993.000000",
];

/** Decimal literals: exceed the field's scale and precision on purpose. */
export const DECIMAL_LITERAL_EXTRA: readonly string[] = [
  "1.5",
  "1.50",
  "1",
  "0.0000001",
  "-0.0000005",
  "100000000000000000000000000000000",
  "-0",
  "42",
];

/** Date edge values. */
export const DATE_POOL: readonly string[] = [
  "0001-01-01",
  "9999-12-31",
  "2024-02-29",
  "2026-10-25",
  "2026-10-24",
  "2026-10-26",
  "2026-03-29",
  "2026-01-31",
  "2026-02-28",
  "2025-12-31",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-09-06",
];

/** The zones of the DST pool. */
export const ZONES: readonly string[] = [
  "America/New_York",
  "Europe/Berlin",
  "Australia/Lord_Howe",
  "Asia/Kathmandu",
  "Pacific/Apia",
  "UTC",
];

const MS_PER_HOUR = 3_600_000;

const transitionInstants = (): number[] => {
  const instants: number[] = [];

  for (const zone of ZONES) {
    let cursor = Temporal.ZonedDateTime.from({
      day: 1,
      month: 1,
      timeZone: zone,
      year: 2026,
    });

    for (let step = 0; step < 2; step += 1) {
      const next = cursor.getTimeZoneTransition("next");

      if (next === null) {
        break;
      }

      const at = next.epochMilliseconds;
      instants.push(
        at - 1,
        at,
        at + MS_PER_HOUR,
        next.startOfDay().epochMilliseconds
      );
      cursor = next;
    }

    const midnight = Temporal.ZonedDateTime.from({
      day: 20,
      month: 10,
      timeZone: zone,
      year: 2026,
    });

    instants.push(
      midnight.epochMilliseconds,
      midnight.epochMilliseconds - 1,
      midnight.add({ days: 5 }).epochMilliseconds
    );
  }

  return instants;
};

/** Date-time edge values as epoch milliseconds: DST instants and limits. */
export const DATE_TIME_POOL: readonly number[] = [
  ...transitionInstants(),
  // Pacific/Apia skipped 2011-12-30 entirely.
  Date.UTC(2011, 11, 29, 10, 0, 0),
  Date.UTC(2011, 11, 30, 10, 0, 0),
  Date.UTC(2026, 9, 20, 12, 0, 0, 123),
  -62_135_596_800_000,
  253_402_300_799_999,
];

/** Choice keys. */
export const CHOICE_POOL: readonly string[] = [
  "open",
  "closed",
  "lost",
  "a",
  "a_1",
  "9z",
];

/** Record IDs of the reference target rows. */
export const PERSON_IDS: readonly string[] = Array.from(
  { length: 6 },
  (_, index) => stableId(0x1_00_00 + index)
);

/** UUIDs for uuid fields, `me` and `myGroups`. */
export const UUID_POOL: readonly string[] = [
  ...PERSON_IDS,
  "ffffffff-ffff-7fff-bfff-ffffffffffff",
  "00000000-0000-0000-0000-000000000000",
];

/** JSON values for json fields. */
export const JSON_POOL: readonly JsonValue[] = [
  {},
  [],
  { a: 1 },
  { a: 1, b: [true, null] },
  // Shaped like write-only states; for json fields they are plain data.
  { set: false },
  { set: true },
  "x",
  0,
  true,
  null,
];

/** Condition values for condition fields. */
export const CONDITION_POOL: readonly JsonValue[] = [
  { op: "true" },
  { op: "false" },
  { args: [], op: "and" },
];
