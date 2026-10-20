import type { getBuiltinModule } from "node:process";

/** A named import from a Node built-in can acquire a module loader. */
export type ViaBuiltinNamed = typeof getBuiltinModule;
