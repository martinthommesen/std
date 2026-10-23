/**
 * The pinned specifications (Contracts 11.1 and 15.1): the shape of
 * `packages/tmf/specs/pins.json`, the single source of every pin. Each entry
 * names one specification at one version, the step whose gate first covers
 * it, and, for a TM Forum Open API, its base path, the resources STD serves,
 * the vendored OpenAPI document and the Conformance Test Kit.
 *
 * The requirements matrix keeps one file per entry,
 * `docs/conformance/<spec>@<version>.yaml` (`matrixFileName`), and
 * `tooling/check-conformance-matrix.ts` reads this file to know which matrix
 * files must exist and which step's gate covers them.
 */
import {
  Array as SchemaArray,
  isGreaterThanOrEqualTo,
  isLessThanOrEqualTo,
  isPattern,
  Int,
  Literals,
  NonEmptyString,
  optionalKey,
  String as SchemaString,
  Struct,
  decodeUnknownResult,
} from "effect/Schema";

/** Specification names: `TMF621`, `ODA-Component`, `STD-ITIL`. */
const specNamePattern = /^[A-Z][A-Za-z0-9]*(?:-[A-Z][A-Za-z0-9]*)*$/u;

/** Versions: `5.0.1`, `v1`, `14`. Never `@` or `/`, which IDs use as separators. */
const versionPattern = /^v?\d+(?:\.\d+)*$/u;

const sha256Pattern = /^[0-9a-f]{64}$/u;

const httpsUrlPattern = /^https:\/\/\S+$/u;

/** The step whose release gate a pin (or a matrix row) belongs to. */
export const GateStepSchema = Int.check(
  isGreaterThanOrEqualTo(3),
  isLessThanOrEqualTo(5)
);

/** What kind of document a pin names. */
export const SpecificationKindSchema = Literals([
  // TMF630 REST API Design Guidelines.
  "guideline",
  // A TM Forum Open API (TMF621, TMF688, ...).
  "openApi",
  // The ODA Component specification (`oda.tmforum.org/v1`).
  "oda",
  // STD's own statement of a practice (`STD-ITIL@14`, Contracts 14).
  "std",
]);

/** A vendored OpenAPI document (Apache-2.0) and where its bytes came from. */
export const OpenApiDocumentSchema = Struct({
  /** File name in `packages/tmf/specs/`, as published upstream. */
  file: NonEmptyString,
  /** The licence the upstream repository states. */
  licence: NonEmptyString,
  /** SHA-256 of the file's bytes. */
  sha256: SchemaString.check(isPattern(sha256Pattern)),
  /** The raw URL of the file at `upstreamCommit`. */
  sourceUrl: SchemaString.check(isPattern(httpsUrlPattern)),
  /** The last upstream commit that changed the file when it was pinned. */
  upstreamCommit: SchemaString.check(isPattern(/^[0-9a-f]{40}$/u)),
  /** The upstream repository. */
  upstreamRepository: SchemaString.check(isPattern(httpsUrlPattern)),
});

/** A vendored OpenAPI document. */
export type OpenApiDocument = typeof OpenApiDocumentSchema.Type;

/**
 * A TM Forum Conformance Test Kit. Kits are member-distributed material: CI
 * downloads them by URL and digest and never commits them (Contracts 11.1).
 */
export const ConformanceKitSchema = Struct({
  /** The base URL the kit's `config.json` ships with. */
  defaultUrl: SchemaString.check(isPattern(/^https?:\/\/\S+$/u)),
  /** The Docker image (with tag) its compose file runs. */
  image: NonEmptyString,
  /**
   * The image's repository digest (`sha256:...`), which the CTK runner
   * checks after pulling (Contracts 11.1); recorded when the kit is first
   * run (decision 0033).
   */
  imageDigest: optionalKey(
    SchemaString.check(isPattern(/^sha256:[0-9a-f]{64}$/u))
  ),
  /** The kit's own label, which may differ from the API version. */
  name: NonEmptyString,
  /** SHA-256 of the kit's zip. */
  zipSha256: SchemaString.check(isPattern(sha256Pattern)),
  /** Where the zip is published. */
  zipUrl: SchemaString.check(isPattern(httpsUrlPattern)),
});

/** A Conformance Test Kit pin. */
export type ConformanceKit = typeof ConformanceKitSchema.Type;

/** One pinned specification. */
export const SpecificationSchema = Struct({
  /**
   * The workstream that writes this specification's matrix file, while it is
   * not written yet. The check tolerates the missing file outside gate mode
   * and fails it in gate mode.
   */
  awaitingMatrix: optionalKey(NonEmptyString),
  /** The base path STD serves the API under (Open APIs only). */
  basePath: optionalKey(
    SchemaString.check(isPattern(/^\/tmf-api\/\w+\/v\d+$/u))
  ),
  /** The pinned kit; absent when the API has none (TMF688). */
  ctk: optionalKey(ConformanceKitSchema),
  kind: SpecificationKindSchema,
  /** Anything a reader needs to know about the pin. */
  note: optionalKey(NonEmptyString),
  /** The pinned OpenAPI document (Open APIs only). */
  openApi: optionalKey(OpenApiDocumentSchema),
  /** The resources STD serves (Open APIs only). */
  resources: optionalKey(SchemaArray(NonEmptyString)),
  spec: SchemaString.check(isPattern(specNamePattern)),
  /** The first step whose gate covers this specification. */
  step: GateStepSchema,
  title: NonEmptyString,
  version: SchemaString.check(isPattern(versionPattern)),
});

/** One pinned specification. */
export type Specification = typeof SpecificationSchema.Type;

/** `packages/tmf/specs/pins.json`. */
export const PinsFileSchema = Struct({
  $comment: optionalKey(SchemaString),
  specifications: SchemaArray(SpecificationSchema),
});

/** The decoded pins file. */
export type PinsFile = typeof PinsFileSchema.Type;

/**
 * The matrix file name of a pinned specification (Contracts 15.1).
 *
 * @param specification - The pin.
 * @returns `<spec>@<version>.yaml`.
 */
export const matrixFileName = (
  specification: Pick<Specification, "spec" | "version">
): string => `${specification.spec}@${specification.version}.yaml`;

/**
 * Decodes the parsed JSON of a pins file. Unknown keys are refused, so a
 * misspelt property cannot be ignored silently.
 */
export const decodePinsFile = decodeUnknownResult(PinsFileSchema, {
  errors: "all",
  onExcessProperty: "error",
});
