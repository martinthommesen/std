/**
 * The keyset cursor predicate of Contracts 3.5: expanded and null-aware, over
 * exactly the (masked) expressions of `ORDER BY`. Ascending keys sort
 * `NULLS LAST`, descending keys `NULLS FIRST`, and ties break by `id` in the
 * direction of the first key. No row comparison is used, since
 * `(k, id) > ($k, $id)` is NULL when `k` is NULL.
 *
 * When the first key is descending and the cursor's value for it is not null,
 * the predicate also carries the bound `k <= $k`. The expanded form implies
 * it (rows after the cursor have `k < $k`, or `k = $k` and a smaller `id`;
 * nulls sort first, so they are before the cursor), and it gives an index on
 * `k` a start point instead of a scan from the top of the order.
 */
import type { Params } from "./sql-text.ts";

/** One sort key with the cursor's value for it. */
export interface KeysetKey {
  readonly expression: string;
  readonly direction: "asc" | "desc";
  /** The cursor row's (masked) value, as text; `null` when it was empty or hidden. */
  readonly value: string | null;
  readonly cast: string;
}

/** The cursor's `id` and the expression it compares with. */
export interface KeysetId {
  readonly expression: string;
  readonly value: string;
}

/**
 * The `ORDER BY` item for one key.
 *
 * @param expression - The (masked) sort expression.
 * @param direction - The sort direction.
 * @returns The item with its NULLS placement.
 */
export const orderItem = (
  expression: string,
  direction: "asc" | "desc"
): string =>
  direction === "asc"
    ? `${expression} ASC NULLS LAST`
    : `${expression} DESC NULLS FIRST`;

const equalTo = (key: KeysetKey, params: Params): string =>
  key.value === null
    ? `${key.expression} IS NULL`
    : `${key.expression} = ${params.bind(key.value, key.cast)}`;

// Rows strictly after the cursor value on this key alone; `undefined` when none can be.
const after = (key: KeysetKey, params: Params): string | undefined => {
  if (key.value === null) {
    return key.direction === "asc"
      ? undefined
      : `${key.expression} IS NOT NULL`;
  }

  const value = params.bind(key.value, key.cast);

  return key.direction === "asc"
    ? `(${key.expression} > ${value} OR ${key.expression} IS NULL)`
    : `${key.expression} < ${value}`;
};

const conjunction = (parts: readonly string[]): string =>
  parts.length === 1 ? (parts[0] ?? "") : `(${parts.join(" AND ")})`;

/**
 * Rows after the cursor `(keys..., id)`: for each position i, the keys before
 * i are equal and key i is after; or all keys are equal and `id` is after.
 *
 * @param keys - The sort keys with the cursor's values.
 * @param id - The tie-breaking `id`.
 * @param params - Where the cursor values are bound.
 * @returns The predicate.
 */
export const afterCursor = (
  keys: readonly KeysetKey[],
  id: KeysetId,
  params: Params
): string => {
  const [first] = keys;
  const direction = first?.direction ?? "asc";
  const terms: string[] = [];

  for (const [index, key] of keys.entries()) {
    const step = after(key, params);

    if (step !== undefined) {
      terms.push(
        conjunction([
          ...keys.slice(0, index).map((earlier) => equalTo(earlier, params)),
          step,
        ])
      );
    }
  }

  const comparison = direction === "asc" ? ">" : "<";
  terms.push(
    conjunction([
      ...keys.map((key) => equalTo(key, params)),
      `${id.expression} ${comparison} ${params.bind(id.value, "uuid")}`,
    ])
  );

  const expanded =
    terms.length === 1 ? (terms[0] ?? "") : `(${terms.join(" OR ")})`;

  if (first?.direction === "desc" && first.value !== null) {
    return `(${first.expression} <= ${params.bind(first.value, first.cast)} AND ${expanded})`;
  }

  return expanded;
};
