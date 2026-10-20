/**
 * The four tsconfig profiles of Contracts 9. Each workspace package names its
 * profile in `package.json` (`"std": { "profile": "plain" }`) and repeats the
 * matching `@effect/language-service` plugin entry in its `tsconfig.json`,
 * because `extends` replaces the whole `plugins` array.
 *
 * This module is the single source of truth: `check-tsconfig.ts` compares
 * every package against it, and the templates in `tooling/tsconfig/` must
 * match it too. Reasons for every entry: `docs/decisions/0001-effect.md`.
 */
import { Schema } from "effect";

/** The profile names a package may declare. */
export const profileNames = ["plain", "api", "web", "server"] as const;

/** Schema of a profile name. */
export const ProfileNameSchema = Schema.Literals(profileNames);

/** A profile name. */
export type ProfileName = typeof ProfileNameSchema.Type;

/** Unstable modules the shared HttpApi definition and the typed client need. */
const httpApiEntries = ["effect/http-api", "effect/http"] as const;

/** Unstable modules the server package may use (Contracts 9). */
export const serverEntries = [
  "effect/sql",
  "effect/http",
  "effect/http-api",
  "effect/observability",
  "@effect/sql-pg",
  "@effect/platform-node",
  "@effect/opentelemetry",
] as const;

/** Unstable allow list for each profile's non-test files. */
export const allowedUnstableApis: Readonly<
  Record<ProfileName, readonly string[]>
> = {
  api: httpApiEntries,
  plain: [],
  server: serverEntries,
  web: httpApiEntries,
};

/**
 * Test files of every profile may use the server modules (so plain packages'
 * tests can use Postgres) and `@effect/vitest`. Overrides replace the base
 * list, so the server entries are repeated.
 */
export const testAllowedUnstableApis: readonly string[] = [
  ...serverEntries,
  "@effect/vitest",
];

/**
 * Files matched by the test override. Globs resolve relative to the tsconfig
 * that declares them, which is why a package cannot inherit the entry from a
 * shared file through `extends`. `test/**` alone matches no file; the `/*`
 * suffix is required.
 */
export const testFilesGlob = "test/**/*";

/** Effect diagnostics that every profile raises to `error`. */
export const errorDiagnostics = [
  "unstableApiUsage",
  "experimentalApiUsage",
  "outdatedApi",
  "obsoleteSchemaImport",
  "duplicatePackage",
  "floatingEffect",
] as const;

/** The test-files override inside a plugin entry. */
export interface TestOverride {
  readonly include: readonly [string];
  readonly options: { readonly allowedUnstableApis: readonly string[] };
}

/** The `@effect/language-service` plugin entry STD uses. */
export interface PluginEntry {
  readonly allowedExperimentalApis: readonly string[];
  readonly allowedUnstableApis: readonly string[];
  readonly diagnosticSeverity: Readonly<Record<string, "error">>;
  readonly ignoreEffectWarningsInTscExitCode: false;
  readonly name: "@effect/language-service";
  readonly overrides: readonly [TestOverride];
}

/**
 * Builds the plugin entry a package with this profile must carry.
 *
 * @param profile - The profile the package declares.
 * @returns The exact entry, to compare with `compilerOptions.plugins[0]`.
 */
export const pluginEntryFor = (profile: ProfileName): PluginEntry => ({
  allowedExperimentalApis: [],
  allowedUnstableApis: allowedUnstableApis[profile],
  diagnosticSeverity: Object.fromEntries(
    errorDiagnostics.map((rule) => [rule, "error"] as const)
  ),
  ignoreEffectWarningsInTscExitCode: false,
  name: "@effect/language-service",
  overrides: [
    {
      include: [testFilesGlob],
      options: { allowedUnstableApis: testAllowedUnstableApis },
    },
  ],
});
