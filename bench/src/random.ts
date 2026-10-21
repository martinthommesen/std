/**
 * A small seeded pseudo-random generator, so every run draws the same query
 * parameters and write values for a given seed. It is the Park-Miller
 * "minimal standard" generator (multiplier 48271, modulus 2^31 - 1), which
 * needs only exact integer arithmetic in doubles.
 */

const modulus = 2_147_483_647;
const multiplier = 48_271;
const hashBase = 31;
const hexDigits = "0123456789abcdef";
const hexBase = 16;

/** A seeded random source. */
export interface Rng {
  /** A uniform float in `[0, 1)`. */
  readonly next: () => number;
  /** A uniform integer in `[0, bound)`. */
  readonly int: (bound: number) => number;
  /** A uniformly chosen element. */
  readonly pick: <A>(values: readonly A[]) => A;
  /** `count` distinct elements, in random order. */
  readonly sample: <A>(values: readonly A[], count: number) => readonly A[];
  /** `length` random hexadecimal digits. */
  readonly hex: (length: number) => string;
}

const hashSeed = (seed: string): number => {
  let hash = 1;

  for (const char of seed) {
    hash = (hash * hashBase + (char.codePointAt(0) ?? 0)) % modulus;
  }

  return hash === 0 ? 1 : hash;
};

/**
 * Creates a generator from a seed string.
 *
 * @param seed - Any string, for example `"20261020:Q1"`.
 * @returns The generator.
 */
export const makeRng = (seed: string): Rng => {
  let state = hashSeed(seed);

  const next = (): number => {
    state = (state * multiplier) % modulus;

    return (state - 1) / (modulus - 1);
  };

  const int = (bound: number): number => Math.floor(next() * bound);

  const pick = <A>(values: readonly A[]): A => {
    const value = values[int(values.length)];

    if (value === undefined) {
      throw new Error("pick from an empty list");
    }

    return value;
  };

  const sample = <A>(values: readonly A[], count: number): readonly A[] => {
    const pool = [...values];
    const chosen: A[] = [];

    while (chosen.length < count && pool.length > 0) {
      const [value] = pool.splice(int(pool.length), 1);

      if (value !== undefined) {
        chosen.push(value);
      }
    }

    return chosen;
  };

  const hex = (length: number): string =>
    Array.from({ length }, () => hexDigits[int(hexBase)] ?? "0").join("");

  return { hex, int, next, pick, sample };
};
