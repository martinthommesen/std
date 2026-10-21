/**
 * Verifies the Effect versions in `pnpm-lock.yaml` (Contracts 9):
 *
 * - exactly one resolved version of `effect` and of each `@effect/*` runtime
 *   package, all equal to the catalog's `effect` version;
 * - the catalog pins every Effect runtime package to that same version;
 * - `@effect/tsgo` (its own version line) resolves once, to its catalog pin;
 * - `@effect/sql` and `@effect/platform` (Effect 3-era packages) are absent.
 *
 * Usage: `node tooling/check-lockfile.ts [--lockfile <file>] [--workspace <file>]`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { readCatalog, resolvedVersions } from "./lib/lockfile.ts";
import { report, runCheck } from "./lib/report.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "check-lockfile";

const forbiddenPackages = new Set(["@effect/sql", "@effect/platform"]);

// `@effect/tsgo` and its platform binaries follow their own version line.
const isTsgoPackage = (name: string): boolean =>
  name === "@effect/tsgo" || name.startsWith("@effect/tsgo-");

const isEffectRuntimePackage = (name: string): boolean =>
  name === "effect" || (name.startsWith("@effect/") && !isTsgoPackage(name));

const checkVersions = (
  name: string,
  found: ReadonlySet<string>,
  expected: string
): string[] => {
  const list = [...found].toSorted();

  if (list.length === 1 && list[0] === expected) {
    return [];
  }

  return [
    `${name}: resolved to ${list.join(", ")}; expected exactly ${expected}`,
  ];
};

await runCheck(checkName, () => {
  const { values } = parseArgs({
    options: {
      lockfile: {
        default: path.join(repoRoot, "pnpm-lock.yaml"),
        type: "string",
      },
      workspace: {
        default: path.join(repoRoot, "pnpm-workspace.yaml"),
        type: "string",
      },
    },
  });

  const catalog = readCatalog(readFileSync(values.workspace, "utf-8"));
  const versions = resolvedVersions(readFileSync(values.lockfile, "utf-8"));
  const effectVersion = catalog.get("effect");

  if (effectVersion === undefined) {
    throw new Error("the catalog in pnpm-workspace.yaml has no effect entry");
  }

  const problems: string[] = [];

  if (!versions.has("effect")) {
    problems.push("effect: not in the lockfile");
  }

  for (const [name, pinned] of catalog) {
    if (isEffectRuntimePackage(name) && pinned !== effectVersion) {
      problems.push(
        `catalog: ${name} is ${pinned}; Effect runtime packages must all be ${effectVersion}`
      );
    }
  }

  for (const [name, found] of versions) {
    if (forbiddenPackages.has(name)) {
      problems.push(
        `${name}: must not be installed (an Effect 3-era package; Effect 4 ships it inside effect)`
      );
    } else if (isEffectRuntimePackage(name)) {
      problems.push(...checkVersions(name, found, effectVersion));
    } else if (name === "@effect/tsgo") {
      problems.push(
        ...checkVersions(name, found, catalog.get(name) ?? "(not in catalog)")
      );
    }
  }

  report(
    checkName,
    problems,
    `effect and @effect/* resolve once, to ${effectVersion}`
  );
});
