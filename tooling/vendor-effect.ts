/**
 * Re-vendors Effect's source at `vendor/effect` from the `effect@<version>`
 * tag, without touching this repository's history or shallow state:
 *
 * 1. clones the tag (depth 1) into a temporary directory;
 * 2. there, makes a parentless commit holding only the tag's tree, and
 *    fetches that one commit (so no upstream history and no shallow
 *    boundary reaches this repository);
 * 3. replaces `vendor/effect` with that tree (`git read-tree --prefix -u`)
 *    and rewrites `vendor/effect-version.json`.
 *
 * It stages the result and prints the commit command, whose
 * `git-subtree-dir` and `git-subtree-split` trailers `check-vendor` reads.
 *
 * Usage: `node tooling/vendor-effect.ts <version>`, for example `4.0.5`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

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

const checkName = "vendor-effect";
const importBranch = "std-vendor-import";

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await runCommand("git", args, { cwd });

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }

  return result.output.trim();
};

await runCheck(checkName, async () => {
  const [version] = process.argv.slice(2);

  if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("usage: node tooling/vendor-effect.ts <version>");
  }

  const tag = `effect@${version}`;
  const temporary = mkdtempSync(path.join(tmpdir(), "std-vendor-effect-"));
  const clone = path.join(temporary, "effect");

  try {
    await git(temporary, [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--branch",
      tag,
      `${effectRepository}.git`,
      clone,
    ]);

    const commit = await git(clone, ["rev-parse", "HEAD"]);
    const tree = await git(clone, ["rev-parse", "HEAD^{tree}"]);

    const treeOnly = await git(clone, [
      "-c",
      "user.name=std vendor-effect",
      "-c",
      "user.email=vendor-effect@invalid",
      "commit-tree",
      tree,
      "-m",
      `${tag} tree (${commit}), without history`,
    ]);

    await git(clone, ["branch", importBranch, treeOnly]);
    await git(repoRoot, ["fetch", "--quiet", "--no-tags", clone, importBranch]);

    if (
      (await git(repoRoot, ["rev-parse", "--is-shallow-repository"])) !==
      "false"
    ) {
      throw new Error(
        "the fetch made this repository shallow; stop and investigate"
      );
    }

    await git(repoRoot, [
      "rm",
      "-r",
      "-q",
      "--ignore-unmatch",
      "--",
      vendorPrefix,
    ]);
    rmSync(path.join(repoRoot, vendorPrefix), { force: true, recursive: true });
    await git(repoRoot, [
      "read-tree",
      `--prefix=${vendorPrefix}/`,
      "-u",
      "FETCH_HEAD",
    ]);
    rmSync(await git(repoRoot, ["rev-parse", "--git-path", "FETCH_HEAD"]), {
      force: true,
    });

    const record: VendorRecord = {
      commit,
      package: "effect",
      prefix: vendorPrefix,
      repository: effectRepository,
      tag,
      tree,
      version,
    };

    writeFileSync(
      path.join(repoRoot, vendorRecordPath),
      `${Schema.encodeSync(VendorRecordJson)(record)}\n`
    );
    await git(repoRoot, ["add", "--", vendorRecordPath]);

    report(
      checkName,
      [],
      `staged ${vendorPrefix} at ${tag} (commit ${commit}, tree ${tree}). Commit it with:\n  git commit -s -m "Vendor Effect ${version} source in ${vendorPrefix}" -m "git-subtree-dir: ${vendorPrefix}" -m "git-subtree-split: ${commit}"\nthen run pnpm check:tooling.`
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});
