/**
 * Limits what plain-profile packages import from Effect in `src/`: only the
 * Schema modules listed in `lib/plain-imports.ts`. Stability diagnostics
 * cannot catch this, because `Effect`, `Layer` and `Stream` are stable.
 *
 * Usage: `node tooling/check-imports.ts [package-dir ...]`. Without arguments
 * it checks every plain package in the workspace. Reports `file:line:column`.
 */
import { globSync, readFileSync } from "node:fs";
import path from "node:path";

import { findPlainImportProblems } from "./lib/plain-imports.ts";
import { report, runCheck } from "./lib/report.ts";
import {
  listWorkspacePackages,
  packagesFromArgs,
  repoRoot,
} from "./lib/workspace.ts";

const checkName = "check-imports";

const sourceGlob = "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

await runCheck(checkName, () => {
  const args = process.argv.slice(2);

  const packages = (
    args.length > 0 ? packagesFromArgs(args) : listWorkspacePackages()
  ).filter((pkg) => pkg.profile === "plain");

  let fileCount = 0;

  const problems = packages.flatMap((pkg) =>
    globSync(sourceGlob, { cwd: pkg.dir, exclude: ["**/node_modules/**"] })
      .toSorted()
      .flatMap((file) => {
        fileCount += 1;
        const filePath = path.join(pkg.dir, file);
        const label = path.relative(repoRoot, filePath);

        return findPlainImportProblems(
          filePath,
          readFileSync(filePath, "utf-8")
        ).map(
          (problem) =>
            `${label}:${problem.line}:${problem.column}: ${problem.message}`
        );
      })
  );

  report(
    checkName,
    problems,
    `${fileCount} file(s) in ${packages.length} plain package(s) import only Schema from Effect`
  );
});
