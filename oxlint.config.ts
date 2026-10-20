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

export default defineConfig({
  env: core.env ?? {},
  extends: [core, react, vitest, shadcn, antiSlop, jsPlugins],
  // vendor/ holds Effect's upstream source, read as reference only.
  ignorePatterns: [...(core.ignorePatterns ?? []), "vendor/**"],
  jsPlugins: [...jsPlugins.jsPlugins, ...shadcn.jsPlugins],
  options: { typeAware: true },
  settings: jsPluginSettings,
});
