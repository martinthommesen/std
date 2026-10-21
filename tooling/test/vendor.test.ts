import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { runTool } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": the vendored Effect source equals the tag
// of the lockfile's version; docs/decisions/0010-foldkit-tooling.md: so does
// the vendored Foldkit source once foldkit is installed, and FOLDKIT.md equals
// its template. Each case is a throwaway git repository that vendors tiny
// "upstream" trees under repos/, with the trailers tooling/vendor.ts writes.
const effectCommit = "7f524e25cfb49a71ac39b0f44278d08d40dda5de";
const foldkitCommit = "7ee214268c602967937b80f6f20d1e831f2e8ab6";
const temporary = mkdtempSync(path.join(tmpdir(), "std-vendor-canary-"));

const foldkitTemplate =
  "repos/foldkit/packages/create-foldkit-app/templates/base/FOLDKIT.md";

const guideText = "# Foldkit Conventions\n\nFoldkit owns this file.\n";

const lockedPackage = (key: string): string =>
  `\n  ${key}:\n    resolution: {integrity: sha512-AAAA}\n`;

const lockfile = (foldkit: readonly string[]): string =>
  [
    "lockfileVersion: '9.0'\n\npackages:\n",
    lockedPackage("effect@4.0.5"),
    ...foldkit.map((version) => lockedPackage(`foldkit@${version}`)),
  ].join("");

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await runCommand(
    "git",
    [
      "-c",
      "user.name=canary",
      "-c",
      "user.email=canary@invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd }
  );

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.output}`);
  }

  return result.output.trim();
};

const write = (root: string, file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

/** Options that break one property of a correctly vendored repository. */
interface Breakage {
  readonly effectRecordVersion?: string;
  readonly effectRepository?: string;
  readonly effectSplit?: string;
  readonly foldkitGuide?: string;
  readonly foldkitSplit?: string;
  readonly lockedFoldkit?: readonly string[];
}

/** One tiny upstream repository to vendor. */
interface Upstream {
  readonly commit: string;
  readonly files: Readonly<Record<string, string>>;
  readonly name: "effect" | "foldkit";
  readonly recordVersion: string;
  readonly repository: string;
  readonly split: string;
  readonly version: string;
}

const vendor = async (root: string, upstream: Upstream): Promise<void> => {
  const prefix = `repos/${upstream.name}`;

  for (const [file, text] of Object.entries(upstream.files)) {
    write(root, `${prefix}/${file}`, text);
  }

  await git(root, ["add", "."]);
  await git(root, [
    "commit",
    "-q",
    "-m",
    `Vendor ${upstream.name} ${upstream.version} source in ${prefix}`,
    "-m",
    `git-subtree-dir: ${prefix}\ngit-subtree-split: ${upstream.split}`,
  ]);

  const tree = await git(root, ["rev-parse", `HEAD:${prefix}`]);

  write(
    root,
    `repos/${upstream.name}-version.json`,
    `${JSON.stringify({
      commit: upstream.commit,
      package: upstream.name,
      prefix,
      repository: upstream.repository,
      tag: `${upstream.name}@${upstream.recordVersion}`,
      tree,
      version: upstream.recordVersion,
    })}\n`
  );
  await git(root, ["add", "."]);
  await git(root, [
    "commit",
    "-q",
    "-m",
    `Record the vendored ${upstream.name}`,
  ]);
};

const vendoredRepo = async (
  name: string,
  breakage: Breakage = {}
): Promise<string> => {
  const root = path.join(temporary, name);

  write(root, "pnpm-lock.yaml", lockfile(breakage.lockedFoldkit ?? []));
  write(root, "FOLDKIT.md", breakage.foldkitGuide ?? guideText);
  await git(root, ["init", "-q"]);
  await vendor(root, {
    commit: effectCommit,
    files: {
      "README.md": "Upstream Effect.\n",
      "packages/effect/package.json":
        '{ "name": "effect", "version": "4.0.5" }\n',
    },
    name: "effect",
    recordVersion: breakage.effectRecordVersion ?? "4.0.5",
    repository:
      breakage.effectRepository ?? "https://github.com/Effect-TS/effect",
    split: breakage.effectSplit ?? effectCommit,
    version: "4.0.5",
  });
  await vendor(root, {
    commit: foldkitCommit,
    files: {
      "README.md": "Upstream Foldkit.\n",
      "packages/create-foldkit-app/templates/base/FOLDKIT.md": guideText,
      "packages/foldkit/package.json":
        '{ "name": "foldkit", "version": "0.169.0" }\n',
    },
    name: "foldkit",
    recordVersion: "0.169.0",
    repository: "https://github.com/foldkit/foldkit",
    split: breakage.foldkitSplit ?? foldkitCommit,
    version: "0.169.0",
  });

  return root;
};

const checkVendor = async (root: string) =>
  await runTool("check-vendor.ts", ["--root", root]);

describe("vendored-effect-check", () => {
  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it("passes the repository's vendored source", async () => {
    const result = await runTool("check-vendor.ts");

    expect(result.output).toContain(
      "repos/effect is effect@4.0.5 (commit 7f524e2, tree 208c4ac)"
    );
    expect(result.output).toContain(
      "repos/foldkit is foldkit@0.169.0 (commit 7ee2142, tree f9dd0aa)"
    );
    expect(result.code).toBe(0);
  });

  it("passes a correctly vendored fixture repository", async () => {
    const result = await checkVendor(await vendoredRepo("clean"));

    expect(result.output).toContain("FOLDKIT.md matches its template");
    expect(result.code).toBe(0);
  });

  it("fails when one committed vendored file differs from the upstream tree", async () => {
    const root = await vendoredRepo("drift");

    write(root, "repos/effect/README.md", "Patched locally.\n");
    write(root, "repos/foldkit/README.md", "Patched locally.\n");
    await git(root, ["commit", "-q", "-am", "Edit vendored source"]);

    const result = await checkVendor(root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("repos/effect: committed tree is");
    expect(result.output).toContain("upstream foldkit@0.169.0 has tree");
  });

  it("fails on uncommitted changes in repos/effect and repos/foldkit", async () => {
    const root = await vendoredRepo("dirty");

    write(root, "repos/effect/extra.ts", "export {};\n");
    write(root, "repos/foldkit/extra.ts", "export {};\n");

    const result = await checkVendor(root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("repos/effect: uncommitted changes");
    expect(result.output).toContain("repos/foldkit: uncommitted changes");
  });

  it("fails when the vendored Effect tag differs from the lockfile", async () => {
    const result = await checkVendor(
      await vendoredRepo("tag", { effectRecordVersion: "4.0.4" })
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "repos/effect-version.json: effect@4.0.4, but the lockfile resolves effect 4.0.5"
    );
  });

  it("fails a different repository or a squash commit for another upstream commit", async () => {
    const roots = await Promise.all([
      vendoredRepo("repository", {
        effectRepository: "https://example.com/effect",
      }),
      vendoredRepo("split", {
        effectSplit: "0".repeat(40),
        foldkitSplit: "1".repeat(40),
      }),
    ]);

    const results = await Promise.all(roots.map(checkVendor));

    expect(results.map((result) => result.code)).toStrictEqual([1, 1]);
    expect(results[0]?.output).toContain(
      "repos/effect-version.json: repository https://example.com/effect"
    );
    expect(results[1]?.output).toContain(
      `does not have "git-subtree-split: ${effectCommit}"`
    );
    expect(results[1]?.output).toContain(
      `does not have "git-subtree-split: ${foldkitCommit}"`
    );
  });
});

describe("vendored-foldkit-check", () => {
  it("passes once the lockfile installs the vendored Foldkit version", async () => {
    const result = await checkVendor(
      await vendoredRepo("foldkit-installed", { lockedFoldkit: ["0.169.0"] })
    );

    expect(result.output).toContain(
      "repos/foldkit is foldkit@0.169.0 (commit 7ee2142, tree"
    );
    expect(result.output).toContain("matching the lockfile");
    expect(result.code).toBe(0);
  });

  it("fails when the lockfile's foldkit is not the vendored tag", async () => {
    const results = await Promise.all([
      checkVendor(
        await vendoredRepo("foldkit-upgraded", { lockedFoldkit: ["0.170.0"] })
      ),
      checkVendor(
        await vendoredRepo("foldkit-two", {
          lockedFoldkit: ["0.169.0", "0.170.0"],
        })
      ),
    ]);

    expect(results.map((result) => result.code)).toStrictEqual([1, 1]);
    expect(results[0]?.output).toContain(
      "repos/foldkit-version.json: foldkit@0.169.0, but the lockfile resolves foldkit 0.170.0; re-vendor with node tooling/vendor.ts foldkit <version>"
    );
    expect(results[1]?.output).toContain(
      "the lockfile resolves foldkit 0.169.0, 0.170.0"
    );
  });

  it("fails when FOLDKIT.md differs from the vendored template, naming the copy command", async () => {
    const result = await checkVendor(
      await vendoredRepo("foldkit-guide", {
        foldkitGuide: `${guideText}\nA local edit.\n`,
      })
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `FOLDKIT.md: differs from ${foldkitTemplate}`
    );
    expect(result.output).toContain(`cp ${foldkitTemplate} FOLDKIT.md`);
  });
});
