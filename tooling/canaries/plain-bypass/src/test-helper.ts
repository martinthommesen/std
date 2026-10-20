import type { Effect } from "../test/helpers.ts";

/** A file outside src/ re-exports stable Effect. */
export type ViaTestHelper = typeof Effect;
