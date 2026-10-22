import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectedFoldkitRules,
  lintEnvironment,
  probeFoldkitLint,
  probeSource,
  runOxlint,
} from "../lib/foldkit-lint.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { fixture } from "./run-tools.ts";

// docs/decisions/0010-foldkit-tooling.md: the root oxlint.config.ts runs the
// Foldkit plugin's "all" preset on apps/web only, and `pnpm check` fails when
// it does not (tooling/check-foldkit-lint.ts). Oxlint changes its default
// output format when it detects an AI agent, which is how this canary once
// passed locally and failed on GitHub. The probe therefore reads
// `--format json` in an allow-listed environment.

// Every agent marker Oxlint 1.88.0 detects (apps/oxlint/src/agent_detection.rs
// at the oxlint_v1.88.0 tag).
const agentMarkers = (searchPath: string): NodeJS.ProcessEnv => ({
  AI_AGENT: "canary",
  CLAUDECODE: "1",
  CLAUDE_CODE: "1",
  CODEX_SANDBOX: "seatbelt",
  CODEX_THREAD_ID: "canary",
  COPILOT_CLI: "1",
  CURSOR_AGENT: "1",
  EDITOR: "devin",
  GEMINI_CLI: "1",
  JUNIE_DATA: "canary",
  JUNIE_SHIM_PATH: "canary",
  OPENCODE: "1",
  PATH: `${searchPath}${path.delimiter}/home/canary/.pi/agent/bin`,
  REPL_ID: "canary",
  TERM_PROGRAM: "kiro",
});

const markedEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...agentMarkers(process.env.PATH ?? ""),
});

const guard = async (args: readonly string[], env: NodeJS.ProcessEnv) =>
  await runCommand(
    process.execPath,
    [path.join(repoRoot, "tooling", "check-foldkit-lint.ts"), ...args],
    { cwd: repoRoot, env }
  );

/**
 * Lints a one-line `var` file outside the repository in Oxlint's default
 * format for the environment.
 *
 * @param env - Oxlint's full environment.
 * @returns Oxlint's output.
 */
const defaultFormat = async (env: NodeJS.ProcessEnv): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "std-oxlint-format-"));

  try {
    writeFileSync(path.join(directory, "probe.js"), "var probe = 1;\n");

    const result = await runOxlint(
      ["-A", "all", "-D", "no-var", "probe.js"],
      directory,
      env
    );

    return result.output;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("foldkit-oxlint-scope", () => {
  it("passes the fixture under the repository's own lint", async () => {
    const result = await runOxlint(
      ["--format", "json", path.relative(repoRoot, probeSource)],
      repoRoot,
      lintEnvironment()
    );

    expect(result.output).not.toContain("foldkit(");
    expect(result.code).toBe(0);
  });

  it("fires Foldkit rules on apps/web, applies the test-file override, and none on packages/server", async () => {
    const probe = await probeFoldkitLint();

    expect(probe.rules).toStrictEqual(expectedFoldkitRules);
    expect(probe.code).toBe(1);
  });

  it("gives the same result with every known agent marker set", async () => {
    const results = await Promise.all([
      probeFoldkitLint(),
      probeFoldkitLint({
        extraEnv: agentMarkers(lintEnvironment().PATH ?? ""),
      }),
    ]);

    expect(results.map((result) => result.rules)).toStrictEqual([
      expectedFoldkitRules,
      expectedFoldkitRules,
    ]);
  });

  it("keeps every agent marker out of Oxlint's environment", async () => {
    const env = lintEnvironment(markedEnvironment());

    const [controlled, marked] = await Promise.all([
      defaultFormat(env),
      defaultFormat(markedEnvironment()),
    ]);

    const allowed = new Set([
      "CI",
      "GITHUB_ACTIONS",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
    ]);

    expect(Object.keys(env).filter((name) => !allowed.has(name))).toStrictEqual(
      []
    );
    expect(env.PATH).not.toContain(".pi/agent");
    // GitHub's annotation format, which CI sees, not the one-line agent format.
    expect(controlled).toContain("::error file=probe.js,line=1");
    expect(controlled).not.toContain("probe.js:1:1: error");
    // The markers do switch Oxlint to its agent format when they get through.
    expect(marked).toContain("probe.js:1:1: error eslint(no-var)");
  });

  it("passes the pnpm check guard, with or without agent markers in its own environment", async () => {
    const results = await Promise.all([
      guard([], lintEnvironment()),
      guard([], markedEnvironment()),
    ]);

    for (const result of results) {
      expect(result.output).toContain("@foldkit/oxlint-plugin is loaded");
      expect(result.code).toBe(0);
    }
  });

  it("fails the pnpm check guard when the config does not load the plugin", async () => {
    const result = await guard(
      ["--config", path.join(fixture("foldkit-lint"), "without-foldkit.ts")],
      markedEnvironment()
    );

    expect(result.output).toContain(
      "apps/web/src/counter.ts: expected foldkit/no-module-level-mutable-state, foldkit/no-switch-on-message-tag, got none"
    );
    expect(result.code).toBe(1);
  });
});
