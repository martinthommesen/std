import type { helper } from "@std-canary/plain-tests/testing/helper";

/** Another plain package's "exports" lead outside its src/. */
export type ViaPlainPackageTests = typeof helper;
