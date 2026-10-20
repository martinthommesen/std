import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { runTool } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": the vendored Effect source equals the tag
// of the lockfile's version. Each case is a throwaway git repository that
// vendors a tiny "upstream" tree the way tooling/vendor-effect.ts does.
const upstreamCommit = "7f524e25cfb49a71ac39b0f44278d08d40dda5de";
const repository = "https://github.com/Effect-TS/effect";
const temporary = mkdtempSync(path.join(tmpdir(), "std-vendor-canary-"));

const lockfile = `lockfileVersion: '9.0'

packages:

  effect@4.0.5:
    resolution: {integrity: sha512-AAAA}
`;

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
  readonly recordVersion?: string;
  readonly repository?: string;
  readonly split?: string;
}

const vendoredRepo = async (
  name: string,
  breakage: Breakage = {}
): Promise<string> => {
  const root = path.join(temporary, name);
  const version = breakage.recordVersion ?? "4.0.5";

  write(root, "pnpm-lock.yaml", lockfile);
  write(
    root,
    "vendor/effect/packages/effect/package.json",
    '{ "name": "effect", "version": "4.0.5" }\n'
  );
  write(root, "vendor/effect/README.md", "Upstream Effect.\n");
  await git(root, ["init", "-q"]);
  await git(root, ["add", "."]);
  await git(root, [
    "commit",
    "-q",
    "-m",
    "Vendor Effect 4.0.5 source in vendor/effect",
    "-m",
    `git-subtree-dir: vendor/effect\ngit-subtree-split: ${breakage.split ?? upstreamCommit}`,
  ]);

  const tree = await git(root, ["rev-parse", "HEAD:vendor/effect"]);

  write(
    root,
    "vendor/effect-version.json",
    `${JSON.stringify({
      commit: upstreamCommit,
      package: "effect",
      prefix: "vendor/effect",
      repository: breakage.repository ?? repository,
      tag: `effect@${version}`,
      tree,
      version,
    })}\n`
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "Record the vendored version"]);

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
      "vendor/effect is effect@4.0.5 (commit 7f524e2, tree 208c4ac)"
    );
    expect(result.code).toBe(0);
  });

  it("passes a correctly vendored fixture repository", async () => {
    const result = await checkVendor(await vendoredRepo("clean"));

    expect(result.code).toBe(0);
  });

  it("fails when one committed vendored file differs from the upstream tree", async () => {
    const root = await vendoredRepo("drift");

    write(root, "vendor/effect/README.md", "Patched locally.\n");
    await git(root, ["commit", "-q", "-am", "Edit vendored source"]);

    const result = await checkVendor(root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("the vendored source differs from the tag");
  });

  it("fails on uncommitted changes in vendor/effect", async () => {
    const root = await vendoredRepo("dirty");

    write(root, "vendor/effect/extra.ts", "export {};\n");

    const result = await checkVendor(root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("vendor/effect: uncommitted changes");
  });

  it("fails when the vendored tag differs from the lockfile", async () => {
    const result = await checkVendor(
      await vendoredRepo("tag", { recordVersion: "4.0.4" })
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "vendor record: tag effect@4.0.4, but the lockfile needs effect@4.0.5"
    );
  });

  it("fails a different repository or a squash commit for another upstream commit", async () => {
    const roots = await Promise.all([
      vendoredRepo("repository", { repository: "https://example.com/effect" }),
      vendoredRepo("split", { split: "0".repeat(40) }),
    ]);

    const results = await Promise.all(roots.map(checkVendor));

    expect(results.map((result) => result.code)).toStrictEqual([1, 1]);
    expect(results[0]?.output).toContain(
      "vendor record: repository https://example.com/effect"
    );
    expect(results[1]?.output).toContain(
      `does not have "git-subtree-split: ${upstreamCommit}"`
    );
  });
});
