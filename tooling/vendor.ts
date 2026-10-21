/**
 * Vendors an upstream repository under `repos/` at a release tag, in the
 * layout `git subtree add --squash` produces, without fetching upstream
 * history into this repository or making it shallow:
 *
 * 1. clones the tag (depth 1) into a temporary directory, makes a parentless
 *    commit there holding only the tag's tree, and fetches that one commit
 *    (no upstream history and no shallow boundary reach this repository);
 * 2. here, wraps that tree in a parentless squash commit whose message
 *    carries the `git-subtree-dir` and `git-subtree-split` trailers (the
 *    prefix and the upstream commit), as `git subtree` writes them;
 * 3. starts a merge of that squash commit (`git merge -s ours --no-commit`),
 *    replaces the prefix with its tree (`git read-tree --prefix -u`) and
 *    rewrites the version record, such as `repos/foldkit-version.json`.
 *
 * Committing the prepared merge (`git commit -s`) gives the history
 * `git subtree add --squash` would, so both this script and
 * `git subtree pull --squash` can re-pin it later, and `check-vendor` finds
 * the trailers.
 *
 * Usage: `node tooling/vendor.ts effect|foldkit VERSION [--trailer LINE]...`,
 * for example `node tooling/vendor.ts foldkit 0.169.0`. Each `--trailer`
 * (such as a `Co-Authored-By` line) is added to the squash commit's message,
 * after its `Signed-off-by` line.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { report, runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import type { VendoredSource, VendorRecord } from "./lib/vendor.ts";
import {
  releaseTag,
  VendoredPackageSchema,
  vendoredSources,
  VendorRecordJson,
} from "./lib/vendor.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "vendor";
const importBranch = "std-vendor-import";

const usage =
  "usage: node tooling/vendor.ts <effect|foldkit> <version> [--trailer <line>]...";

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await runCommand("git", args, { cwd });

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }

  return result.output.trim();
};

/** What the command line asks for. */
interface Request {
  readonly source: VendoredSource;
  readonly trailers: readonly string[];
  readonly version: string;
}

const readRequest = (): Request => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { trailer: { default: [], multiple: true, type: "string" } },
  });

  const [name, version, ...rest] = positionals;
  const isPackage = Schema.is(VendoredPackageSchema);

  const source = vendoredSources.find(
    (candidate) => isPackage(name) && candidate.package === name
  );

  if (
    source === undefined ||
    version === undefined ||
    rest.length > 0 ||
    !/^\d+\.\d+\.\d+$/u.test(version)
  ) {
    throw new Error(usage);
  }

  return { source, trailers: values.trailer, version };
};

/** The upstream tag, cloned at depth 1 into a temporary directory. */
interface Upstream {
  readonly clone: string;
  readonly commit: string;
  readonly tree: string;
}

const cloneTag = async (
  temporary: string,
  source: VendoredSource,
  tag: string
): Promise<Upstream> => {
  const clone = path.join(temporary, source.package);

  await git(temporary, [
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--branch",
    tag,
    `${source.repository}.git`,
    clone,
  ]);

  return {
    clone,
    commit: await git(clone, ["rev-parse", "HEAD"]),
    tree: await git(clone, ["rev-parse", "HEAD^{tree}"]),
  };
};

/**
 * Fetches the tag's tree into this repository through a parentless commit,
 * so neither upstream history nor a shallow boundary arrives.
 *
 * @param upstream - The cloned tag.
 * @param tag - The tag, for the throwaway commit's message.
 */
const fetchTree = async (upstream: Upstream, tag: string): Promise<void> => {
  const treeOnly = await git(upstream.clone, [
    "-c",
    "user.name=std vendor",
    "-c",
    "user.email=vendor@invalid",
    "commit-tree",
    upstream.tree,
    "-m",
    `${tag} tree (${upstream.commit}), without history`,
  ]);

  await git(upstream.clone, ["branch", importBranch, treeOnly]);
  await git(repoRoot, [
    "fetch",
    "--quiet",
    "--no-tags",
    upstream.clone,
    importBranch,
  ]);
  rmSync(await git(repoRoot, ["rev-parse", "--git-path", "FETCH_HEAD"]), {
    force: true,
  });

  if (
    (await git(repoRoot, ["rev-parse", "--is-shallow-repository"])) !== "false"
  ) {
    throw new Error(
      "the fetch made this repository shallow; stop and investigate"
    );
  }
};

/**
 * Writes `git subtree`'s squash commit: the tag's tree, no parents, and the
 * subtree trailers, signed off by the committer.
 *
 * @param request - The source, version and extra trailers.
 * @param upstream - The cloned tag.
 * @returns The squash commit's id.
 */
const squashCommit = async (
  request: Request,
  upstream: Upstream
): Promise<string> => {
  const identity = await git(repoRoot, ["var", "GIT_COMMITTER_IDENT"]);
  // "Name <email> 1700000000 +0000": keep the name and the address.
  const signer = identity.slice(0, identity.lastIndexOf(">") + 1);
  const { prefix } = request.source;

  return await git(repoRoot, [
    "commit-tree",
    upstream.tree,
    "-m",
    `Squashed '${prefix}/' content from commit ${upstream.commit.slice(0, 12)}`,
    "-m",
    [
      `git-subtree-dir: ${prefix}`,
      `git-subtree-split: ${upstream.commit}`,
      `Signed-off-by: ${signer}`,
      ...request.trailers,
    ].join("\n"),
  ]);
};

const requireCleanIndex = async (): Promise<void> => {
  const staged = await runCommand(
    "git",
    ["diff", "--cached", "--quiet", "HEAD"],
    { cwd: repoRoot }
  );

  const merging = await runCommand(
    "git",
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: repoRoot }
  );

  if (staged.code !== 0 || merging.code === 0) {
    throw new Error(
      "commit or unstage your changes (and finish any merge) before vendoring"
    );
  }
};

const committedTree = async (prefix: string): Promise<string | undefined> => {
  const result = await runCommand("git", ["rev-parse", `HEAD:${prefix}`], {
    cwd: repoRoot,
  });

  return result.code === 0 ? result.output.trim() : undefined;
};

/**
 * Starts the merge and replaces the prefix with the squash commit's tree.
 *
 * @param request - The source and version.
 * @param upstream - The cloned tag.
 * @param squash - The squash commit to merge.
 */
const prepareMerge = async (
  request: Request,
  upstream: Upstream,
  squash: string
): Promise<void> => {
  const { source, version } = request;
  const tag = releaseTag(source, version);

  await git(repoRoot, [
    "merge",
    "--quiet",
    "-s",
    "ours",
    "--no-ff",
    "--no-commit",
    "--allow-unrelated-histories",
    "-m",
    `Vendor ${source.displayName} ${version} source in ${source.prefix}`,
    "-m",
    `Merges ${squash}, the squashed ${tag} tree (upstream commit ${upstream.commit}, tree ${upstream.tree}), as git subtree add --squash would.`,
    squash,
  ]);
  await git(repoRoot, [
    "rm",
    "-r",
    "-q",
    "--ignore-unmatch",
    "--",
    source.prefix,
  ]);
  rmSync(path.join(repoRoot, source.prefix), { force: true, recursive: true });
  await git(repoRoot, [
    "read-tree",
    `--prefix=${source.prefix}/`,
    "-u",
    squash,
  ]);

  const record: VendorRecord = {
    commit: upstream.commit,
    package: source.package,
    prefix: source.prefix,
    repository: source.repository,
    tag,
    tree: upstream.tree,
    version,
  };

  writeFileSync(
    path.join(repoRoot, source.recordPath),
    `${Schema.encodeSync(VendorRecordJson)(record)}\n`
  );
  await git(repoRoot, ["add", "--", source.recordPath]);
};

await runCheck(checkName, async () => {
  const request = readRequest();
  const { source, version } = request;
  const tag = releaseTag(source, version);

  await requireCleanIndex();

  const temporary = mkdtempSync(path.join(tmpdir(), "std-vendor-"));

  try {
    const upstream = await cloneTag(temporary, source, tag);

    if ((await committedTree(source.prefix)) === upstream.tree) {
      report(
        checkName,
        [],
        `${source.prefix} already holds ${tag} (tree ${upstream.tree}); nothing to do`
      );

      return;
    }

    await fetchTree(upstream, tag);

    const squash = await squashCommit(request, upstream);

    await prepareMerge(request, upstream, squash);

    report(
      checkName,
      [],
      `prepared a merge of ${source.prefix} at ${tag} (squash commit ${squash}, upstream commit ${upstream.commit}, tree ${upstream.tree}). Review it, commit it with:\n  git commit -s\nthen run pnpm check:tooling.`
    );
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});
