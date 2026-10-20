import type { hidden } from "./bridge/hidden.ts";

/** src/bridge is a symlink to src/node_modules (written by the test). */
export type ViaBridge = typeof hidden;
