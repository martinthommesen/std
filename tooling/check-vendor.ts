/**
 * Verifies that the vendored Effect source is exactly the upstream tag the
 * lockfile needs, from the files themselves rather than labels, without
 * network access or the upstream commit:
 *
 * - `vendor/effect-version.json` names `effect@<lockfile version>`, the
 *   documented repository, a commit and that commit's tree hash;
 * - the committed tree at `HEAD:vendor/effect` is that tree hash, so not one
 *   vendored file differs from upstream;
 * - `vendor/effect` has no uncommitted or untracked changes;
 * - the latest commit that vendored it carries the `git-subtree-dir` and
 *   `git-subtree-split: <commit>` trailers;
 * - the vendored `packages/effect/package.json` has the lockfile version.
 *
 * Usage: `node tooling/check-vendor.ts [--root <dir>]`. `--root` (default:
 * this repository) must be the top of a git work tree.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { lockedEffectVersion } from "./lib/lockfile.ts";
import { report, runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import type { VendorRecord } from "./lib/vendor.ts";
import {
  effectRepository,
  vendorPrefix,
  VendorRecordJson,
  vendorRecordPath,
} from "./lib/vendor.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-vendor";

const objectId = /^[0-9a-f]{40}$/u;

const VendoredPackageJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, version: Schema.String })
);

const git = async (
  root: string,
  args: readonly string[]
): Promise<{ ok: boolean; out: string }> => {
  const result = await runCommand("git", ["-C", root, ...args], { cwd: root });

  return { ok: result.code === 0, out: result.output.trim() };
};

const checkRecord = (record: VendorRecord, locked: string): string[] => {
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

  if (record.repository !== effectRepository) {
    problems.push(
      `vendor record: repository ${record.repository}, expected ${effectRepository}`
    );
  }

  if (record.prefix !== vendorPrefix) {
    problems.push(
      `vendor record: prefix ${record.prefix}, expected ${vendorPrefix}`
    );
  }

  for (const [field, value] of [
    ["commit", record.commit],
    ["tree", record.tree],
  ] as const) {
    if (!objectId.test(value)) {
      problems.push(
        `vendor record: ${field} must be a 40-character object id, found ${JSON.stringify(value)}`
      );
    }
  }

  return problems;
};

const checkManifest = (root: string, locked: string): string[] => {
  const manifest = path.join(
    root,
    vendorPrefix,
    "packages",
    "effect",
    "package.json"
  );

  if (!existsSync(manifest)) {
    return [
      `${vendorPrefix}/packages/effect/package.json: missing; re-vendor (docs/decisions/0001-effect.md)`,
    ];
  }

  const vendored = Schema.decodeSync(VendoredPackageJson)(
    readFileSync(manifest, "utf-8")
  );

  return vendored.name === "effect" && vendored.version === locked
    ? []
    : [
        `${vendorPrefix}/packages/effect/package.json: ${vendored.name}@${vendored.version}, expected effect@${locked}`,
      ];
};

const checkGit = async (
  root: string,
  record: VendorRecord
): Promise<string[]> => {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);

  if (!top.ok || realpathSync(top.out) !== realpathSync(root)) {
    return [`${root}: not the top of a git work tree`];
  }

  const problems: string[] = [];
  const tree = await git(root, ["rev-parse", `HEAD:${vendorPrefix}`]);

  if (tree.out !== record.tree) {
    problems.push(
      `${vendorPrefix}: committed tree is ${tree.ok ? tree.out : "missing"}, but upstream ${record.tag} has tree ${record.tree}; the vendored source differs from the tag`
    );
  }

  const status = await git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    vendorPrefix,
  ]);

  if (status.out !== "") {
    problems.push(
      `${vendorPrefix}: uncommitted changes:\n${status.out.split("\n").slice(0, 10).join("\n")}`
    );
  }

  const squash = await git(root, [
    "log",
    "-1",
    "--format=%B",
    `--grep=^git-subtree-dir: ${vendorPrefix}/*$`,
    "HEAD",
  ]);

  if (!squash.out.includes(`git-subtree-split: ${record.commit}`)) {
    problems.push(
      `${vendorPrefix}: the latest commit with "git-subtree-dir: ${vendorPrefix}" does not have "git-subtree-split: ${record.commit}" (CI needs the full history: fetch-depth 0)`
    );
  }

  return problems;
};

await runCheck(checkName, async () => {
  const { values } = parseArgs({
    options: { root: { default: repoRoot, type: "string" } },
  });

  const root = path.resolve(values.root);

  const locked = lockedEffectVersion(
    readFileSync(path.join(root, "pnpm-lock.yaml"), "utf-8")
  );

  const record = Schema.decodeSync(VendorRecordJson)(
    readFileSync(path.join(root, vendorRecordPath), "utf-8")
  );

  const problems = [
    ...checkRecord(record, locked),
    ...checkManifest(root, locked),
    ...(await checkGit(root, record)),
  ];

  report(
    checkName,
    problems,
    `${vendorPrefix} is ${record.tag} (commit ${record.commit.slice(0, 7)}, tree ${record.tree.slice(0, 7)}), matching the lockfile`
  );
});
