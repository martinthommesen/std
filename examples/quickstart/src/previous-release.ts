/**
 * The release `pnpm release-compat:ci` upgrades from. Each release moves
 * it to the tag it just published, so every branch proves that the latest
 * release's databases and clients keep working (docs/architecture.md,
 * "Checks and scripts").
 */
export const PREVIOUS_RELEASE = "v0.0.1";
