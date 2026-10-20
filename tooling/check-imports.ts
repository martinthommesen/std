/**
 * Limits what plain-profile packages' `src/` may load: from Effect only the
 * Schema modules listed in `lib/plain-resolve.ts`, no Node built-ins or host
 * globals, only their own scanned `src/` files, plain workspace packages, and
 * third-party packages in `tooling/plain-allowed-deps.json` whose dependency
 * graph has no Effect. Stability diagnostics cannot catch this, because
 * `Effect`, `Layer` and `Stream` are stable.
 *
 * Every file under `src/` is scanned, and symlinks or `node_modules`
 * directories inside `src/` are refused, so nothing in `src/` goes unread.
 *
 * Usage: `node tooling/check-imports.ts [--allowed-deps <file>] [package-dir ...]`.
 * Without directories it checks every plain package in the workspace.
 * Reports `file:line:column`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { findPlainImportProblems } from "./lib/plain-imports.ts";
import { scannedExtensions } from "./lib/plain-resolve.ts";
import { report, runCheck } from "./lib/report.ts";
import type { WorkspacePackage } from "./lib/workspace.ts";
import {
  listWorkspacePackages,
  packagesFromArgs,
  repoRoot,
} from "./lib/workspace.ts";

const checkName = "check-imports";

/** `tooling/plain-allowed-deps.json`: package name to the reason it is allowed. */
const AllowedDependencies = Schema.fromJsonString(
  Schema.Struct({ packages: Schema.Record(Schema.String, Schema.String) })
);

/** The files to scan in one package's `src/`, and what was refused. */
interface SourceTree {
  readonly files: string[];
  readonly problems: string[];
}

// Lists every file under `dir` (dot-directories included), refusing symlinks
// and node_modules directories, which would hide files from the scan.
const walkSource = (dir: string): SourceTree => {
  const files: string[] = [];
  const problems: string[] = [];
  const pending = [dir];

  for (
    let current = pending.pop();
    current !== undefined;
    current = pending.pop()
  ) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const label = path.relative(repoRoot, entryPath);

      if (entry.isSymbolicLink()) {
        problems.push(
          `${label}: symlinks are not allowed in a plain package's src/`
        );
      } else if (entry.isDirectory() && entry.name === "node_modules") {
        problems.push(
          `${label}: node_modules is not allowed in a plain package's src/`
        );
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (scannedExtensions.has(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }

  return { files: files.toSorted(), problems };
};

const checkPackage = (
  pkg: WorkspacePackage,
  context: Omit<Parameters<typeof findPlainImportProblems>[2], "pkg">
): SourceTree => {
  const src = path.join(pkg.dir, "src");

  if (!existsSync(src)) {
    return { files: [], problems: [] };
  }

  const tree = walkSource(src);

  const problems = tree.files.flatMap((file) =>
    findPlainImportProblems(file, readFileSync(file, "utf-8"), {
      ...context,
      pkg,
    }).map(
      (problem) =>
        `${path.relative(repoRoot, file)}:${problem.line}:${problem.column}: ${problem.message}`
    )
  );

  return { files: tree.files, problems: [...tree.problems, ...problems] };
};

await runCheck(checkName, () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "allowed-deps": {
        default: path.join(repoRoot, "tooling", "plain-allowed-deps.json"),
        type: "string",
      },
    },
  });

  const allowedDependencies = new Map(
    Object.entries(
      Schema.decodeSync(AllowedDependencies)(
        readFileSync(values["allowed-deps"], "utf-8")
      ).packages
    )
  );

  const workspacePackages = listWorkspacePackages();

  const selected =
    positionals.length > 0 ? packagesFromArgs(positionals) : workspacePackages;

  const workspace = new Map(
    [...workspacePackages, ...selected].map((pkg) => [pkg.name, pkg] as const)
  );

  const packages = selected.filter((pkg) => pkg.profile === "plain");

  const results = packages.map((pkg) =>
    checkPackage(pkg, { allowedDependencies, workspace })
  );

  const fileCount = results.reduce(
    (sum, result) => sum + result.files.length,
    0
  );

  report(
    checkName,
    results.flatMap((result) => result.problems),
    `${fileCount} file(s) in ${packages.length} plain package(s) import only Schema from Effect`
  );
});
