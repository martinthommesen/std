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
// environment (the terse `agent` format under an AI agent, the graphical
// one elsewhere, such as in CI), so the probe never parses that.
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

/**
 * Lints the probe file at `apps/web/src`, at `apps/web/src` as a test file
 * and at `packages/server/src` of a temporary tree. Override globs and JS
 * plugin specifiers resolve from the config's directory, so the tree's
 * `oxlint.config.ts` re-exports `config` unchanged and the tree links the
 * root `node_modules`.
 *
 * @param config - The Oxlint config to probe; defaults to the root config.
 * @param env - The environment for Oxlint; defaults to this process's.
 * @returns The Foldkit rules reported per probe file.
 */
export const probeFoldkitLint = async (
  config: string = rootOxlintConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<FoldkitLintProbe> => {
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

    const result = await runCommand(
      path.join(repoRoot, "node_modules", ".bin", "oxlint"),
      [
        "--format",
        "json",
        "-c",
        path.join(temporary, configName),
        ...Object.values(probeFiles),
      ],
      { cwd: temporary, env }
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
