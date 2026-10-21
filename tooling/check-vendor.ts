/**
 * Verifies that each vendored upstream repository under `repos/` (Effect and
 * Foldkit, `tooling/lib/vendor.ts`) is exactly the release tag the lockfile
 * needs, from the files themselves rather than labels, without network
 * access or the upstream commit:
 *
 * - `repos/<package>-version.json` names `<package>@<version>`, the
 *   documented repository, a commit and that commit's tree hash;
 * - the lockfile resolves the package to exactly that version (Effect must
 *   be installed; Foldkit is checked once the lockfile has it);
 * - the committed tree at `HEAD:repos/<package>` is that tree hash, so not
 *   one vendored file differs from upstream;
 * - `repos/<package>` has no uncommitted or untracked changes;
 * - the latest commit that vendored it carries the `git-subtree-dir` and
 *   `git-subtree-split: <commit>` trailers;
 * - the vendored package's `package.json` has the recorded version;
 * - Foldkit only: the root `FOLDKIT.md` is byte-for-byte the vendored
 *   `create-foldkit-app` template, which Foldkit owns.
 *
 * Usage: `node tooling/check-vendor.ts [--root <dir>]`. `--root` (default:
 * this repository) must be the top of a git work tree.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { lockedVersions } from "./lib/lockfile.ts";
import { report, runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import type { VendoredSource, VendorRecord } from "./lib/vendor.ts";
import {
  foldkitSource,
  releaseTag,
  vendoredSources,
  VendorRecordJson,
} from "./lib/vendor.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-vendor";

const objectId = /^[0-9a-f]{40}$/u;

/** Foldkit's agent guide, owned by Foldkit and copied verbatim. */
const foldkitGuide = "FOLDKIT.md";
const foldkitGuideTemplate = `${foldkitSource.prefix}/packages/create-foldkit-app/templates/base/FOLDKIT.md`;

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

/** One vendored source, as this check finds it. */
interface Subject {
  readonly locked: readonly string[];
  readonly record: VendorRecord;
  readonly root: string;
  readonly source: VendoredSource;
}

const checkLockfile = ({ locked, record, source }: Subject): string[] => {
  if (locked.length === 0) {
    return source.requiredInLockfile
      ? [
          `pnpm-lock.yaml: ${source.package} is not resolved, but ${source.prefix} needs it`,
        ]
      : [];
  }

  return locked.length === 1 && locked[0] === record.version
    ? []
    : [
        `${source.recordPath}: ${record.tag}, but the lockfile resolves ${source.package} ${locked.join(", ")}; re-vendor with node tooling/vendor.ts ${source.package} <version> (and refresh what depends on it)`,
      ];
};

const checkRecord = ({ record, source }: Subject): string[] => {
  const problems: string[] = [];
  const label = source.recordPath;

  if (record.package !== source.package) {
    problems.push(
      `${label}: package ${record.package}, expected ${source.package}`
    );
  }

  if (record.tag !== releaseTag(source, record.version)) {
    problems.push(
      `${label}: tag ${record.tag}, but version ${record.version} needs ${releaseTag(source, record.version)}`
    );
  }

  if (record.repository !== source.repository) {
    problems.push(
      `${label}: repository ${record.repository}, expected ${source.repository}`
    );
  }

  if (record.prefix !== source.prefix) {
    problems.push(
      `${label}: prefix ${record.prefix}, expected ${source.prefix}`
    );
  }

  for (const [field, value] of [
    ["commit", record.commit],
    ["tree", record.tree],
  ] as const) {
    if (!objectId.test(value)) {
      problems.push(
        `${label}: ${field} must be a 40-character object id, found ${JSON.stringify(value)}`
      );
    }
  }

  return problems;
};

const checkManifest = ({ record, root, source }: Subject): string[] => {
  const relative = `${source.prefix}/${source.manifest}`;
  const manifest = path.join(root, relative);

  if (!existsSync(manifest)) {
    return [`${relative}: missing; re-vendor with node tooling/vendor.ts`];
  }

  const vendored = Schema.decodeSync(VendoredPackageJson)(
    readFileSync(manifest, "utf-8")
  );

  return vendored.name === source.package && vendored.version === record.version
    ? []
    : [
        `${relative}: ${vendored.name}@${vendored.version}, expected ${source.package}@${record.version}`,
      ];
};

const checkGit = async ({
  record,
  root,
  source,
}: Subject): Promise<string[]> => {
  const problems: string[] = [];
  const { prefix } = source;
  const tree = await git(root, ["rev-parse", `HEAD:${prefix}`]);

  if (tree.out !== record.tree) {
    problems.push(
      `${prefix}: committed tree is ${tree.ok ? tree.out : "missing"}, but upstream ${record.tag} has tree ${record.tree}; the vendored source differs from the tag`
    );
  }

  const status = await git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    prefix,
  ]);

  if (status.out !== "") {
    problems.push(
      `${prefix}: uncommitted changes:\n${status.out.split("\n").slice(0, 10).join("\n")}`
    );
  }

  const squash = await git(root, [
    "log",
    "-1",
    "--format=%B",
    `--grep=^git-subtree-dir: ${prefix}/*$`,
    "HEAD",
  ]);

  if (!squash.out.includes(`git-subtree-split: ${record.commit}`)) {
    problems.push(
      `${prefix}: the latest commit with "git-subtree-dir: ${prefix}" does not have "git-subtree-split: ${record.commit}" (CI needs the full history: fetch-depth 0)`
    );
  }

  return problems;
};

const checkFoldkitGuide = (root: string): string[] => {
  const template = path.join(root, foldkitGuideTemplate);
  const guide = path.join(root, foldkitGuide);
  const copy = `cp ${foldkitGuideTemplate} ${foldkitGuide}`;

  if (!existsSync(template)) {
    return [`${foldkitGuideTemplate}: missing from the vendored tag`];
  }

  if (!existsSync(guide)) {
    return [`${foldkitGuide}: missing; Foldkit owns it, so copy it: ${copy}`];
  }

  return readFileSync(guide).equals(readFileSync(template))
    ? []
    : [
        `${foldkitGuide}: differs from ${foldkitGuideTemplate}; Foldkit owns it and replaces it whole on upgrade, so never edit it (STD's own rules go in AGENTS.md) and refresh it after a re-pin: ${copy}`,
      ];
};

const checkSource = async (subject: Subject): Promise<string[]> => [
  ...checkRecord(subject),
  ...checkLockfile(subject),
  ...checkManifest(subject),
  ...(await checkGit(subject)),
  ...(subject.source === foldkitSource ? checkFoldkitGuide(subject.root) : []),
];

const describeSubject = ({ locked, record, source }: Subject): string =>
  `${source.prefix} is ${record.tag} (commit ${record.commit.slice(0, 7)}, tree ${record.tree.slice(0, 7)}), ${locked.length === 0 ? "not installed yet" : "matching the lockfile"}`;

await runCheck(checkName, async () => {
  const { values } = parseArgs({
    options: { root: { default: repoRoot, type: "string" } },
  });

  const root = path.resolve(values.root);
  const top = await git(root, ["rev-parse", "--show-toplevel"]);

  if (!top.ok || realpathSync(top.out) !== realpathSync(root)) {
    report(checkName, [`${root}: not the top of a git work tree`], "");

    return;
  }

  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf-8");

  const subjects = vendoredSources.map((source): Subject => ({
    locked: lockedVersions(lockfile, source.package),
    record: Schema.decodeSync(VendorRecordJson)(
      readFileSync(path.join(root, source.recordPath), "utf-8")
    ),
    root,
    source,
  }));

  const results = await Promise.all(subjects.map(checkSource));
  const problems = results.flat();

  report(
    checkName,
    problems,
    `${subjects.map(describeSubject).join("; ")}; ${foldkitGuide} matches its template`
  );
});
