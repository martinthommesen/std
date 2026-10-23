/**
 * The canonical STD release version, recorded in the migration ledger.
 */
import packageJson from "../package.json" with { type: "json" };

/** The release version. Publishing requires a matching v<version> tag. */
export const STD_VERSION: string = packageJson.version;
