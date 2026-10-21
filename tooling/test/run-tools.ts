import path from "node:path";

import type { CommandResult } from "../lib/run.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

/** Directory of the canary fixture packages. */
export const canariesDir = path.join(repoRoot, "tooling", "canaries");

/**
 * Resolves a fixture directory.
 *
 * @param name - The fixture's directory name in `tooling/canaries/`.
 * @returns Its absolute path.
 */
export const fixture = (name: string): string => path.join(canariesDir, name);

/**
 * Runs an executable from `node_modules/.bin` in the repository root.
 *
 * @param bin - The executable's name, such as `tsc`.
 * @param args - Its arguments.
 * @returns The exit code and the output.
 */
export const runBin = async (
  bin: string,
  args: readonly string[]
): Promise<CommandResult> =>
  await runCommand(path.join(repoRoot, "node_modules", ".bin", bin), args, {
    cwd: repoRoot,
  });

/**
 * Type-checks a fixture package with the patched `tsc`.
 *
 * @param name - The fixture's directory name.
 * @returns The exit code and the diagnostics.
 */
export const runTsc = async (name: string): Promise<CommandResult> =>
  await runBin("tsc", ["-p", path.join(fixture(name), "tsconfig.json")]);

/**
 * Runs one of the `tooling/*.ts` scripts with the current Node.
 *
 * @param script - The script's file name, such as `check-imports.ts`.
 * @param args - Its arguments.
 * @returns The exit code and the output.
 */
export const runTool = async (
  script: string,
  args: readonly string[] = []
): Promise<CommandResult> =>
  await runCommand(
    process.execPath,
    [path.join(repoRoot, "tooling", script), ...args],
    { cwd: repoRoot }
  );
