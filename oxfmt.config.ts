import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // repos/ holds the upstream Effect and Foldkit source, kept byte-for-byte
  // as published, and FOLDKIT.md is Foldkit's own template, copied verbatim;
  // .claude/ holds agent worktrees, each a full checkout with its own config;
  // .agents/ and skills-lock.json are third-party agent skills pinned by hash;
  // packages/tmf/specs/ holds TM Forum's OpenAPI documents, pinned by SHA-256;
  // deploy/oda/crds/ holds the ODA Canvas's Component CRD, copied verbatim
  // (a Helm template, not plain YAML).
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "repos/**",
    "FOLDKIT.md",
    ".claude/**",
    ".agents/**",
    "skills-lock.json",
    "packages/tmf/specs/*.oas.yaml",
    "packages/tmf/specs/*.swagger.json",
    "deploy/oda/crds/**",
  ],
});
