/**
 * Case folding and text keys (Contracts 5.5).
 *
 * `fold(x)` is Unicode full case folding (CaseFolding.txt statuses C and F)
 * from the shipped table, equal to Postgres
 * `casefold(x COLLATE pg_unicode_fast)` for the same Unicode version. Folding
 * maps each code point independently, so it needs no context and is not
 * re-normalized.
 */
import {
  ASSIGNED_RANGES,
  FULL_FOLDINGS,
  SIMPLE_FOLD_RUNS,
} from "./fold-table.ts";

/** The Unicode version of the fold table; `doctor` compares it with Postgres. */
export { FOLD_TABLE_UNICODE_VERSION as UNICODE_VERSION } from "./fold-table.ts";

const HEX = 16;
const ASCII_LIMIT = 0x80;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const MAX_CODE_POINT = 0x10_ff_ff;

const buildFoldMap = (): ReadonlyMap<number, string> => {
  const map = new Map<number, string>();

  for (const run of SIMPLE_FOLD_RUNS.join(";").split(";")) {
    const [start = 0, count = 0, step = 0, delta = 0] = run
      .split(",")
      .map((part) => Number.parseInt(part, HEX));

    for (let index = 0; index < count; index += 1) {
      const from = start + index * step;
      map.set(from, String.fromCodePoint(from + delta));
    }
  }

  for (const entry of FULL_FOLDINGS.join(";").split(";")) {
    const [from = "", to = ""] = entry.split(":");
    map.set(
      Number.parseInt(from, HEX),
      String.fromCodePoint(
        ...to.split(" ").map((part) => Number.parseInt(part, HEX))
      )
    );
  }

  return map;
};

const buildAssigned = (): Int32Array => {
  const ranges = ASSIGNED_RANGES.join(";").split(";");
  const bounds = new Int32Array(ranges.length * 2);

  for (const [index, range] of ranges.entries()) {
    const [start = "", end = ""] = range.split("-");
    bounds[index * 2] = Number.parseInt(start, HEX);
    bounds[index * 2 + 1] = Number.parseInt(end, HEX);
  }

  return bounds;
};

const FOLD_MAP = buildFoldMap();
const ASSIGNED = buildAssigned();

/**
 * Folds one code point.
 *
 * @param codePoint - A Unicode scalar value.
 * @returns Its full case folding, one to three code points.
 */
export const foldCodePoint = (codePoint: number): string =>
  FOLD_MAP.get(codePoint) ?? String.fromCodePoint(codePoint);

const needsFolding = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.codePointAt(index) ?? 0;

    if (unit >= ASCII_LIMIT || (unit >= UPPER_A && unit <= UPPER_Z)) {
      return true;
    }
  }

  return false;
};

/**
 * Unicode full case folding.
 *
 * @param text - Well-formed text.
 * @returns The folded text: `"Straße"` gives `"strasse"`, `"ΣΑΣ"` gives
 *   `"σασ"`, `"İ"` gives `"i\u0307"` (i and U+0307).
 */
export const fold = (text: string): string => {
  if (!needsFolding(text)) {
    return text;
  }

  let folded = "";

  for (const character of text) {
    folded += FOLD_MAP.get(character.codePointAt(0) ?? 0) ?? character;
  }

  return folded;
};

/**
 * The comparison key of a text value.
 *
 * @param text - Converted text.
 * @param caseSensitive - The field's `caseSensitive` setting.
 * @returns `fold(text)`, or the text itself when case-sensitive.
 */
export const textKey = (text: string, caseSensitive: boolean): string =>
  caseSensitive ? text : fold(text);

/**
 * Whether a code point is assigned in the fold table's Unicode version
 * (DerivedAge.txt). The browser evaluator returns Unknown for text holding
 * newer code points, whose folding and normalization it cannot trust.
 *
 * @param codePoint - A code point.
 * @returns True when assigned in {@link UNICODE_VERSION}.
 */
export const isAssignedInFoldTableVersion = (codePoint: number): boolean => {
  if (codePoint < 0 || codePoint > MAX_CODE_POINT) {
    return false;
  }

  let low = 0;
  let high = ASSIGNED.length / 2 - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (codePoint < (ASSIGNED[middle * 2] ?? 0)) {
      high = middle - 1;
    } else if (codePoint > (ASSIGNED[middle * 2 + 1] ?? 0)) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
};

/**
 * Whether every code point of a text is assigned in the fold table's version.
 *
 * @param text - The text to check.
 * @returns False when the text holds a code point newer than the table.
 */
export const isFullyAssignedInFoldTableVersion = (text: string): boolean => {
  for (const character of text) {
    if (!isAssignedInFoldTableVersion(character.codePointAt(0) ?? -1)) {
      return false;
    }
  }

  return true;
};
