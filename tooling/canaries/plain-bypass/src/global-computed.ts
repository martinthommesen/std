const key = "process";

// oxlint-disable-next-line typescript/no-unsafe-assignment -- the canary reads a host global the base tsconfig does not type
const host = globalThis[key];

/** Computed access through the global object. */
export type ViaComputed = typeof host;
