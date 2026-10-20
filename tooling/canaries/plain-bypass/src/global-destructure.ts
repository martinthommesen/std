// oxlint-disable-next-line typescript/no-unsafe-assignment -- the canary reads a host global the base tsconfig does not type
const { getBuiltinModule } = process;

/** Destructuring the global process object. */
export type ViaDestructure = typeof getBuiltinModule;
