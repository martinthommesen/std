import type { labelOrNone } from "@std-canary/plain-tests/label";

/** Another plain package's src/, through its "exports", is allowed. */
export type ViaPlainPackage = typeof labelOrNone;
