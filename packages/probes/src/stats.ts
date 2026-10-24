/**
 * Summaries of latency samples.
 */

/** Percentiles of a set of samples, in the samples' unit. */
export interface Summary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

const PERCENT = 100;
const MEDIAN = 50;
const P95 = 95;
const P99 = 99;

/**
 * The nearest-rank percentile of sorted samples.
 * @param sorted - Samples in ascending order.
 * @param percent - The percentile, 0 to 100.
 * @returns The sample at that rank, or 0 for no samples.
 */
export const percentile = (
  sorted: readonly number[],
  percent: number
): number => {
  if (sorted.length === 0) {
    return 0;
  }

  const rank = Math.ceil((percent / PERCENT) * sorted.length);

  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
};

/**
 * Summarizes samples.
 * @param samples - Any samples.
 * @returns Count, mean, p50, p95, p99 and max.
 */
export const summarize = (samples: readonly number[]): Summary => {
  const sorted = samples.toSorted((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    count: sorted.length,
    max: sorted.at(-1) ?? 0,
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    p50: percentile(sorted, MEDIAN),
    p95: percentile(sorted, P95),
    p99: percentile(sorted, P99),
  };
};

/**
 * The longest time between consecutive events, including from `from` to
 * the first and from the last to `to`.
 * @param times - Event times, in any order.
 * @param from - Start of the window.
 * @param to - End of the window.
 * @returns The longest gap.
 */
export const longestGap = (
  times: readonly number[],
  from: number,
  to: number
): number => {
  const inside = times
    .filter((time) => time >= from && time <= to)
    .toSorted((left, right) => left - right);

  let previous = from;
  let longest = 0;

  for (const time of inside) {
    longest = Math.max(longest, time - previous);
    previous = time;
  }

  return Math.max(longest, to - previous);
};

/**
 * Rounds to a fixed number of decimals for reports.
 * @param value - Any number.
 * @param digits - Decimals to keep.
 * @returns The rounded number.
 */
export const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
};
