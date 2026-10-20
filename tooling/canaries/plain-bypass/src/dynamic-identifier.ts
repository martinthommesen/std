const moduleName = "effect/Effect";

/** Loads stable Effect with a specifier held in a variable. */
export const viaDynamicIdentifier = async (): Promise<void> => {
  await import(moduleName);
};
