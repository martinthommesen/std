import type { createRequire } from "node:module";

/** createRequire would load any module at run time. */
export type ViaRequire = typeof createRequire;
