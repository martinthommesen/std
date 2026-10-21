import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // vendor/ holds Effect's upstream source, kept byte-for-byte as published;
  // .claude/ holds agent worktrees, each a full checkout with its own config;
  // .agents/ and skills-lock.json are third-party agent skills pinned by hash.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "vendor/**",
    ".claude/**",
    ".agents/**",
    "skills-lock.json",
  ],
});
