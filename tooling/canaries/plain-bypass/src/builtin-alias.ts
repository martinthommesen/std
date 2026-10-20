// oxlint-disable-next-line unicorn/prefer-node-protocol -- the canary must use the bare built-in name
import type { getBuiltinModule as load } from "process";

/** The bare built-in name, with an alias. */
export type ViaBuiltinAlias = typeof load;
