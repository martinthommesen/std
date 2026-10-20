/**
 * Type-checks the root project (tooling and config files) and every
 * workspace package with the patched `tsc`, so Effect diagnostics are
 * errors. It does not rely on per-package `typecheck` scripts, so a package
 * cannot be skipped by forgetting one.
 *
 * Usage: `node tooling/typecheck.ts [package-dir ...]`.
 */
import { availableParallelism } from "node:os";
import path from "node:path";

import { report, runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import type { WorkspacePackage } from "./lib/workspace.ts";
import {
  listWorkspacePackages,
  packagesFromArgs,
  readPackage,
  repoRoot,
} from "./lib/workspace.ts";

const checkName = "typecheck";
const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");

/** Output of one `tsc` run; `failed` is set when it exited non-zero. */
interface TscResult {
  readonly failed: boolean;
  readonly label: string;
  readonly output: string;
}

const typecheck = async (pkg: WorkspacePackage): Promise<TscResult> => {
  const project = path.join(pkg.dir, "tsconfig.json");

  const { code, output } = await runCommand(tsc, ["-p", project], {
    cwd: repoRoot,
  });

  return { failed: code !== 0, label: pkg.label, output };
};

const runAll = async (
  packages: readonly WorkspacePackage[]
): Promise<TscResult[]> => {
  const results: TscResult[] = [];
  const queue = [...packages];

  const workers = Array.from(
    { length: Math.min(availableParallelism(), queue.length) },
    async () => {
      for (let pkg = queue.shift(); pkg !== undefined; pkg = queue.shift()) {
        // oxlint-disable-next-line no-await-in-loop -- each worker runs its share of packages one after another
        results.push(await typecheck(pkg));
      }
    }
  );

  await Promise.all(workers);

  return results.toSorted((a, b) => a.label.localeCompare(b.label));
};

await runCheck(checkName, async () => {
  const args = process.argv.slice(2);
  const root = readPackage(repoRoot);

  const packages =
    args.length > 0
      ? packagesFromArgs(args)
      : [
          root,
          ...listWorkspacePackages().filter((pkg) => pkg.dir !== root.dir),
        ];

  const results = await runAll(packages);

  for (const result of results) {
    process.stdout.write(result.output);
  }

  report(
    checkName,
    results.flatMap((result) =>
      result.failed ? [`${result.label}: tsc failed`] : []
    ),
    `${results.length} project(s) type-check`
  );
});
