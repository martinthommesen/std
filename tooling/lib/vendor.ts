import { Schema } from "effect";

/** The repository named by the npm metadata of `effect` (without `.git`). */
export const effectRepository = "https://github.com/Effect-TS/effect";

/** Where Effect's source is vendored, relative to the repository root. */
export const vendorPrefix = "vendor/effect";

/** The record of what is vendored, relative to the repository root. */
export const vendorRecordPath = "vendor/effect-version.json";

/** `vendor/effect-version.json`. */
export const VendorRecordSchema = Schema.Struct({
  /** The upstream commit the tag points to. */
  commit: Schema.String,
  package: Schema.Literal("effect"),
  prefix: Schema.String,
  repository: Schema.String,
  tag: Schema.String,
  /** The upstream commit's tree hash; `HEAD:vendor/effect` must equal it. */
  tree: Schema.String,
  version: Schema.String,
});

/** A decoded vendor record. */
export type VendorRecord = typeof VendorRecordSchema.Type;

/** `vendor/effect-version.json` as JSON text. */
export const VendorRecordJson = Schema.fromJsonString(VendorRecordSchema, {
  space: 2,
});
