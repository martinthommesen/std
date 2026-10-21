/**
 * Percentiles over latency samples.
 */

/**
 * The nearest-rank percentile of the samples.
 *
 * @param samples - Latencies in milliseconds.
 * @param p - The percentile, 0 to 100.
 * @returns The sample at that rank, or NaN when there are none.
 */
export const percentile = (samples: readonly number[], p: number): number => {
  if (samples.length === 0) {
    return Number.NaN;
  }

  const sorted = samples.toSorted((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[rank - 1] ?? Number.NaN;
};

/**
 * The index of the sample closest to the median: the run whose plan is reported.
 *
 * @param samples - Latencies in run order.
 * @returns The index of the median run.
 */
export const medianIndex = (samples: readonly number[]): number => {
  const median = percentile(samples, 50);
  let best = 0;

  for (const [index, value] of samples.entries()) {
    if (
      Math.abs(value - median) <
      Math.abs((samples[best] ?? Number.POSITIVE_INFINITY) - median)
    ) {
      best = index;
    }
  }

  return best;
};

/**
 * Rounds to three decimals for reports.
 *
 * @param value - Any number.
 * @returns The rounded number.
 */
export const round3 = (value: number): number =>
  Math.round(value * 1000) / 1000;
