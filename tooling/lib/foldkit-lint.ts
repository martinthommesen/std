import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Result, Schema } from "effect";

import { runCommand } from "./run.ts";
import { repoRoot } from "./workspace.ts";

/** The file name Oxlint looks for in a config directory. */
const configName = "oxlint.config.ts";

/** The root Oxlint config, which `pnpm check` runs. */
export const rootOxlintConfig = path.join(repoRoot, configName);

/** The probe file: a Foldkit-style counter that breaks two Foldkit rules. */
export const probeSource = path.join(
  repoRoot,
  "tooling",
  "canaries",
  "foldkit-lint",
  "counter.ts"
);

/** Where the probe is linted, relative to the temporary tree's root. */
export const probeFiles = {
  server: "packages/server/src/counter.ts",
  web: "apps/web/src/counter.ts",
  webTest: "apps/web/src/counter.test.ts",
} as const;

/** Foldkit rule names per probe file. */
export type FoldkitRulesByFile = Readonly<
  Record<keyof typeof probeFiles, readonly string[]>
>;

const switchOnTag = "no-switch-on-message-tag";

/** The Foldkit rules each probe file must report under the root config. */
export const expectedFoldkitRules: FoldkitRulesByFile = {
  server: [],
  web: ["no-module-level-mutable-state", switchOnTag],
  // The preset's test-file override turns most rules off, but not this one.
  webTest: [switchOnTag],
};

// `--format json` output. Oxlint picks its default format from the
// environment (the one-line `agent` format under an AI agent, GitHub's
// `::error` annotations under GITHUB_ACTIONS, the graphical one in a
// terminal), so the probe never parses that.
const OxlintJson = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        code: Schema.optionalKey(Schema.String),
        filename: Schema.String,
      })
    ),
  })
);

const decodeOxlintJson = Schema.decodeUnknownResult(OxlintJson);

const foldkitCode = /^foldkit\((?<rule>[a-z-]+)\)$/u;

/** What one Oxlint run reported for the probe files. */
export interface FoldkitLintProbe {
  /** Oxlint's exit code. */
  readonly code: number | null;
  /** Oxlint's raw output, for failure messages. */
  readonly output: string;
  /** Sorted Foldkit rule names per probe file; `undefined` when the output was not Oxlint JSON. */
  readonly rules: FoldkitRulesByFile | undefined;
}

const rulesByFile = (
  diagnostics: readonly { readonly code?: string; readonly filename: string }[]
): FoldkitRulesByFile => {
  const rulesFor = (file: string): string[] =>
    diagnostics
      .flatMap((diagnostic) =>
        diagnostic.filename === file
          ? (foldkitCode.exec(diagnostic.code ?? "")?.groups?.rule ?? [])
          : []
      )
      .toSorted();

  return {
    server: rulesFor(probeFiles.server),
    web: rulesFor(probeFiles.web),
    webTest: rulesFor(probeFiles.webTest),
  };
};

// The only variables Oxlint gets from the caller. Oxlint detects AI agents
// from many variables (AI_AGENT, CLAUDECODE, CODEX_THREAD_ID, EDITOR,
// TERM_PROGRAM, ...; apps/oxlint/src/agent_detection.rs) and changes its
// output for them, so the probe passes an allow-list instead of removing
// a list of known markers.
const passedVariables = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"] as const;

// The Pi agent is detected from a PATH segment.
const agentPathSegment = /[/\\]\.pi[/\\]agent(?:[/\\]|$)/u;

/**
 * The controlled environment Oxlint runs in: the allow-listed variables of
 * `base` (PATH without agent segments) and CI's own variables, so the probe
 * behaves the same under an AI agent, in a terminal and in CI.
 *
 * @param base - The environment to take the allow-listed variables from.
 * @returns The environment for Oxlint.
 */
export const lintEnvironment = (
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { CI: "true", GITHUB_ACTIONS: "true" };

  for (const name of passedVariables) {
    const value = base[name];

    if (value !== undefined) {
      env[name] = value;
    }
  }

  if (env.PATH !== undefined) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((entry) => !agentPathSegment.test(entry))
      .join(path.delimiter);
  }

  return env;
};

/**
 * Runs the installed Oxlint with this process's Node, so the pinned Node
 * loads the TypeScript config whatever `node` PATH finds.
 *
 * @param args - Oxlint's arguments.
 * @param cwd - The working directory.
 * @param env - The full environment; use {@link lintEnvironment}.
 * @returns The exit code and the output.
 */
export const runOxlint = async (
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
) =>
  await runCommand(
    process.execPath,
    [path.join(repoRoot, "node_modules", "oxlint", "bin", "oxlint"), ...args],
    { cwd, env }
  );

/** Options for {@link probeFoldkitLint}. */
export interface ProbeOptions {
  /** The Oxlint config to probe; defaults to the root config. */
  readonly config?: string;
  /** Variables added on top of {@link lintEnvironment}, to simulate an agent. */
  readonly extraEnv?: NodeJS.ProcessEnv;
}

/**
 * Lints the probe file at `apps/web/src`, at `apps/web/src` as a test file
 * and at `packages/server/src` of a temporary tree. Override globs and JS
 * plugin specifiers resolve from the config's directory, so the tree's
 * `oxlint.config.ts` re-exports the config unchanged and the tree links the
 * root `node_modules`.
 *
 * @param options - The config, and extra variables for tests.
 * @returns The Foldkit rules reported per probe file.
 */
export const probeFoldkitLint = async (
  options: ProbeOptions = {}
): Promise<FoldkitLintProbe> => {
  const config = options.config ?? rootOxlintConfig;
  const env = { ...lintEnvironment(), ...options.extraEnv };
  const temporary = mkdtempSync(path.join(tmpdir(), "std-foldkit-lint-"));

  try {
    for (const file of Object.values(probeFiles)) {
      mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
      copyFileSync(probeSource, path.join(temporary, file));
    }

    symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(temporary, "node_modules")
    );
    writeFileSync(
      path.join(temporary, configName),
      `export { default } from ${JSON.stringify(path.resolve(config))};\n`
    );

    const result = await runOxlint(
      [
        "--format",
        "json",
        "-c",
        path.join(temporary, configName),
        ...Object.values(probeFiles),
      ],
      temporary,
      env
    );

    const decoded = decodeOxlintJson(result.output);

    return {
      code: result.code,
      output: result.output,
      rules: Result.isSuccess(decoded)
        ? rulesByFile(decoded.success.diagnostics)
        : undefined,
    };
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
};
