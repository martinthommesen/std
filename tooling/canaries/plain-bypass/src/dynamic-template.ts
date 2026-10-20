const moduleName = "Effect";

/** Loads stable Effect with a template specifier that has an expression. */
export const viaDynamicTemplate = async (): Promise<void> => {
  // oxlint-disable-next-line react-doctor/no-dynamic-import-path -- the canary needs a computed template specifier
  await import(`effect/${moduleName}`);
};
