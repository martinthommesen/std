/** Loads stable Effect with a literal dynamic import. */
export const viaDynamicLiteral = async (): Promise<void> => {
  await import("effect/Effect");
};
