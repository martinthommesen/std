import { assert } from "@effect/vitest";
import { Effect } from "effect";
import { asyncProperty, assert as check } from "fast-check";
import type { Arbitrary, Parameters } from "fast-check";

/**
 * Checks that writing hidden samples preserves the observed answers.
 * @param samples - Hidden-value samples.
 * @param write - Writes one sample.
 * @param answers - Observations to compare with the baseline.
 * @param parameters - The property's existing run count and seed.
 * @returns The property, with the caller's services captured for each sample.
 */
export const hiddenValuesProperty = Effect.fnUntraced(
  function* hiddenValuesPropertyWork<A, E, R>(
    samples: Arbitrary<A>,
    write: (sample: A) => Effect.Effect<unknown, E, R>,
    answers: Effect.Effect<readonly string[], E, R>,
    parameters: Parameters<[A]>
  ) {
    const baseline = yield* answers;
    const services = yield* Effect.context<R>();
    const run = Effect.runPromiseWith(services);

    yield* Effect.promise(async () => {
      await check(
        asyncProperty(samples, async (sample) => {
          assert.deepStrictEqual(
            await run(write(sample).pipe(Effect.andThen(answers))),
            baseline
          );
        }),
        parameters
      );
    });
  }
);
