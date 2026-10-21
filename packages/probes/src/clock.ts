/**
 * Wall-clock helpers for measurements. The probes measure real elapsed time
 * on the host, so they read `performance.now()` directly instead of Effect's
 * `Clock`, which tests may replace.
 */
import { Effect } from "effect";

/** The current monotonic time in milliseconds. */
export const now: Effect.Effect<number> = Effect.sync(() => performance.now());

/**
 * Runs an effect and measures how long it took.
 * @param effect - The effect to time.
 * @returns The elapsed milliseconds and the result.
 */
export const timedMillis = Effect.fnUntraced(function* measure<A, E, R>(
  effect: Effect.Effect<A, E, R>
) {
  const started = yield* now;
  const result = yield* effect;
  const finished = yield* now;

  return [finished - started, result] as const;
});
