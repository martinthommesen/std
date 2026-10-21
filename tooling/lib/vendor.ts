import { Schema } from "effect";

/** The npm packages whose upstream repository is vendored under `repos/`. */
export const VendoredPackageSchema = Schema.Literals(["effect", "foldkit"]);

/** `effect` or `foldkit`. */
export type VendoredPackage = typeof VendoredPackageSchema.Type;

/** One upstream repository, vendored read-only under `repos/`. */
export interface VendoredSource {
  /** For messages and commit subjects. */
  readonly displayName: string;
  /**
   * Where the upstream repository keeps the npm package's `package.json`,
   * relative to `prefix`.
   */
  readonly manifest: string;
  /** The npm package; its tags are `<package>@<version>`. */
  readonly package: VendoredPackage;
  /** Where the source is vendored, relative to the repository root. */
  readonly prefix: string;
  /** The record of what is vendored, relative to the repository root. */
  readonly recordPath: string;
  /** The repository named by the package's npm metadata (without `.git`). */
  readonly repository: string;
  /**
   * Whether the lockfile must resolve the package. Effect is installed from
   * the start; Foldkit arrives with the web app, and until then the vendored
   * tag stands alone.
   */
  readonly requiredInLockfile: boolean;
}

/** Effect's repository, at the tag of the lockfile's `effect`. */
export const effectSource: VendoredSource = {
  displayName: "Effect",
  manifest: "packages/effect/package.json",
  package: "effect",
  prefix: "repos/effect",
  recordPath: "repos/effect-version.json",
  repository: "https://github.com/Effect-TS/effect",
  requiredInLockfile: true,
};

/** Foldkit's repository, at the tag of the lockfile's `foldkit`. */
export const foldkitSource: VendoredSource = {
  displayName: "Foldkit",
  manifest: "packages/foldkit/package.json",
  package: "foldkit",
  prefix: "repos/foldkit",
  recordPath: "repos/foldkit-version.json",
  repository: "https://github.com/foldkit/foldkit",
  requiredInLockfile: false,
};

/** Every vendored source, in the order the checks report them. */
export const vendoredSources: readonly VendoredSource[] = [
  effectSource,
  foldkitSource,
];

/**
 * The upstream release tag of a version.
 *
 * @param source - The vendored source.
 * @param version - The npm version, such as `4.0.5`.
 * @returns The tag, such as `effect@4.0.5`.
 */
export const releaseTag = (source: VendoredSource, version: string): string =>
  `${source.package}@${version}`;

/** `repos/<package>-version.json`. */
export const VendorRecordSchema = Schema.Struct({
  /** The upstream commit the tag points to. */
  commit: Schema.String,
  package: VendoredPackageSchema,
  prefix: Schema.String,
  repository: Schema.String,
  tag: Schema.String,
  /** The upstream commit's tree hash; `HEAD:<prefix>` must equal it. */
  tree: Schema.String,
  version: Schema.String,
});

/** A decoded vendor record. */
export type VendorRecord = typeof VendorRecordSchema.Type;

/** `repos/<package>-version.json` as JSON text. */
export const VendorRecordJson = Schema.fromJsonString(VendorRecordSchema, {
  space: 2,
});
