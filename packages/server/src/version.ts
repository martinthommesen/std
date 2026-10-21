/**
 * The STD version, recorded in the migration ledger.
 */
import packageJson from "../package.json" with { type: "json" };

/** The version of `@std/server`. */
export const STD_VERSION: string = packageJson.version;
