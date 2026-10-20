/**
 * Verifies that the vendored Effect source matches the lockfile: the record
 * in `vendor/effect-version.json` names the `effect@<version>` tag of the one
 * `effect` version in `pnpm-lock.yaml`, and the vendored
 * `packages/effect/package.json` carries that same version.
 *
 * Usage: `node tooling/check-vendor.ts [--root <dir>]`. `--root` (default:
 * the repository) is where `pnpm-lock.yaml`, `vendor/effect-version.json` and
 * the record's `prefix` are looked up.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { lockedEffectVersion } from "./lib/lockfile.ts";
import { report, runCheck } from "./lib/report.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-vendor";

const VendorRecord = Schema.fromJsonString(
  Schema.Struct({
    commit: Schema.String,
    package: Schema.Literal("effect"),
    prefix: Schema.String,
    repository: Schema.String,
    tag: Schema.String,
    version: Schema.String,
  })
);

const VendoredPackageJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, version: Schema.String })
);

await runCheck(checkName, () => {
  const { values } = parseArgs({
    options: { root: { default: repoRoot, type: "string" } },
  });

  const root = path.resolve(values.root);

  const locked = lockedEffectVersion(
    readFileSync(path.join(root, "pnpm-lock.yaml"), "utf-8")
  );

  const record = Schema.decodeSync(VendorRecord)(
    readFileSync(path.join(root, "vendor", "effect-version.json"), "utf-8")
  );

  const problems: string[] = [];

  if (record.version !== locked) {
    problems.push(
      `vendor record: version ${record.version}, but the lockfile resolves effect ${locked}`
    );
  }

  if (record.tag !== `effect@${locked}`) {
    problems.push(
      `vendor record: tag ${record.tag}, but the lockfile needs effect@${locked}`
    );
  }

  const manifest = path.join(
    root,
    record.prefix,
    "packages",
    "effect",
    "package.json"
  );

  if (existsSync(manifest)) {
    const vendored = Schema.decodeSync(VendoredPackageJson)(
      readFileSync(manifest, "utf-8")
    );

    if (vendored.name !== "effect" || vendored.version !== locked) {
      problems.push(
        `${path.relative(repoRoot, manifest)}: ${vendored.name}@${vendored.version}, expected effect@${locked}`
      );
    }
  } else {
    problems.push(
      `${path.relative(repoRoot, manifest)}: missing; re-vendor with git subtree (docs/decisions/0001-effect.md)`
    );
  }

  report(
    checkName,
    problems,
    `vendored ${record.prefix} is ${record.tag} (${record.commit.slice(0, 7)}), matching the lockfile`
  );
});
