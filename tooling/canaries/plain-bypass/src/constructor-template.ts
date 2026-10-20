// oxlint-disable-next-line dot-notation, typescript/dot-notation -- the canary needs a template member key
const build = (() => 0)[`constructor`];

/** A template key without substitutions is a static member name. */
export type ViaTemplateConstructor = typeof build;
