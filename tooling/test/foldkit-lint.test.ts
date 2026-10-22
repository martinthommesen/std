import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectedFoldkitRules,
  probeFoldkitLint,
  probeSource,
} from "../lib/foldkit-lint.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { fixture } from "./run-tools.ts";

// docs/decisions/0010-foldkit-tooling.md: the root oxlint.config.ts runs the
// Foldkit plugin's "all" preset on apps/web only, and `pnpm check` fails when
// it does not (tooling/check-foldkit-lint.ts). Oxlint is read through
// `--format json`: its default format depends on the environment (the terse
// `agent` format when CLAUDECODE or AI_AGENT is set, the graphical one in
// CI), which is how this canary once passed locally and failed on GitHub.

/**
 * This environment without the variables that make Oxlint use `agent` output.
 *
 * @returns A copy of `process.env` without `AI_AGENT` and `CLAUDECODE`.
 */
const withoutAgent = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };

  delete env.AI_AGENT;
  delete env.CLAUDECODE;

  return env;
};

const guard = async (args: readonly string[], env: NodeJS.ProcessEnv) =>
  await runCommand(
    process.execPath,
    [path.join(repoRoot, "tooling", "check-foldkit-lint.ts"), ...args],
    { cwd: repoRoot, env }
  );

describe("foldkit-oxlint-scope", () => {
  it("passes the fixture under the repository's own lint", async () => {
    const result = await runCommand(
      path.join(repoRoot, "node_modules", ".bin", "oxlint"),
      ["--format", "json", path.relative(repoRoot, probeSource)],
      { cwd: repoRoot }
    );

    expect(result.output).not.toContain("foldkit(");
    expect(result.code).toBe(0);
  });

  it("fires Foldkit rules on apps/web, applies the test-file override, and none on packages/server", async () => {
    const probe = await probeFoldkitLint();

    expect(probe.rules).toStrictEqual(expectedFoldkitRules);
    expect(probe.code).toBe(1);
  });

  it("gives the same result with and without an AI agent in the environment", async () => {
    const results = await Promise.all([
      probeFoldkitLint(undefined, withoutAgent()),
      probeFoldkitLint(undefined, { ...withoutAgent(), AI_AGENT: "canary" }),
    ]);

    expect(results.map((result) => result.rules)).toStrictEqual([
      expectedFoldkitRules,
      expectedFoldkitRules,
    ]);
  });

  it("passes the pnpm check guard with the root config, in CI's environment", async () => {
    const result = await guard([], {
      ...withoutAgent(),
      CI: "true",
      GITHUB_ACTIONS: "true",
    });

    expect(result.output).toContain("@foldkit/oxlint-plugin is loaded");
    expect(result.code).toBe(0);
  });

  it("fails the pnpm check guard when the config does not load the plugin", async () => {
    const result = await guard(
      ["--config", path.join(fixture("foldkit-lint"), "without-foldkit.ts")],
      withoutAgent()
    );

    expect(result.output).toContain(
      "apps/web/src/counter.ts: expected foldkit/no-module-level-mutable-state, foldkit/no-switch-on-message-tag, got none"
    );
    expect(result.code).toBe(1);
  });
});
