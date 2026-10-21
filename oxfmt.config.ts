import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // repos/ holds the upstream Effect and Foldkit source, kept byte-for-byte
  // as published, and FOLDKIT.md is Foldkit's own template, copied verbatim;
  // .claude/ holds agent worktrees, each a full checkout with its own config;
  // .agents/ and skills-lock.json are third-party agent skills pinned by hash.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "repos/**",
    "FOLDKIT.md",
    ".claude/**",
    ".agents/**",
    "skills-lock.json",
  ],
});
