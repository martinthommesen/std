import foldkitAll from "@foldkit/oxlint-plugin/all.json" with { type: "json" };
import { Schema } from "effect";
import type { OxlintOverride } from "oxlint";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins([
  "github",
  "jsdoc-js",
  "sonarjs",
  "tsdoc",
  "react-doctor",
]);

// Foldkit's "all" preset (docs/decisions/0010-foldkit-tooling.md), decoded so
// that a plugin upgrade that changes the preset's shape fails loudly here.
const FoldkitRules = Schema.Record(
  Schema.String,
  Schema.Literals(["off", "warn", "error"])
);

const FoldkitPreset = Schema.Struct({
  jsPlugins: Schema.Array(
    Schema.Struct({ name: Schema.String, specifier: Schema.String })
  ),
  overrides: Schema.Array(
    Schema.Struct({
      excludeFiles: Schema.optionalKey(Schema.Array(Schema.String)),
      files: Schema.Array(Schema.String),
      rules: FoldkitRules,
    })
  ),
  rules: FoldkitRules,
});

const foldkit = Schema.decodeUnknownSync(FoldkitPreset)(foldkitAll);

// The Foldkit rules apply to the web app only: rules such as
// no-module-level-mutable-state or no-impure-call-at-decision-time describe
// a Foldkit program, not the server or the plain packages.
const webApp = "apps/web";

// The preset's own overrides (server and prerender entry points, tests) use
// "**/" globs; they are re-rooted at the web app so they cannot match, say,
// packages/server/**.
const inWebApp = (glob: string): string => {
  if (!glob.startsWith("**/")) {
    throw new Error(
      `@foldkit/oxlint-plugin all.json: expected a "**/" glob, found ${glob}; re-check the scoping in oxlint.config.ts`
    );
  }

  return `${webApp}/${glob}`;
};

const scopeToWebApp = (
  override: (typeof foldkit.overrides)[number]
): OxlintOverride => {
  const scoped: OxlintOverride = {
    files: override.files.map(inWebApp),
    rules: { ...override.rules },
  };

  if (override.excludeFiles !== undefined) {
    scoped.excludeFiles = override.excludeFiles.map(inWebApp);
  }

  return scoped;
};

const foldkitOverrides: OxlintOverride[] = [
  { files: [`${webApp}/**`], rules: { ...foldkit.rules } },
  ...foldkit.overrides.map(scopeToWebApp),
];

export default defineConfig({
  env: core.env ?? {},
  extends: [core, react, vitest, shadcn, antiSlop, jsPlugins],
  // repos/ holds the upstream Effect and Foldkit source, read as reference
  // only; .claude/ holds agent worktrees. .eslintignore also keeps Oxlint out
  // of both.
  ignorePatterns: [...(core.ignorePatterns ?? []), "repos/**", ".claude/**"],
  // The Foldkit plugin is loaded once, here; only the web app's overrides
  // turn its rules on.
  jsPlugins: [
    ...jsPlugins.jsPlugins,
    ...shadcn.jsPlugins,
    ...foldkit.jsPlugins.map((plugin) => ({ ...plugin })),
  ],
  options: { typeAware: true },
  overrides: foldkitOverrides,
  settings: jsPluginSettings,
});
