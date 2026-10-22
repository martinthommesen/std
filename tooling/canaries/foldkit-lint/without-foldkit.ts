// An Oxlint config that does not load @foldkit/oxlint-plugin. The
// foldkit-oxlint-scope canary runs tooling/check-foldkit-lint.ts with it and
// expects the guard to fail.
import { defineConfig } from "oxlint";

export default defineConfig({});
