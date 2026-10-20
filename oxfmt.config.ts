import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // vendor/ holds Effect's upstream source, kept byte-for-byte as published;
  // .claude/ holds agent worktrees, each a full checkout with its own config.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "vendor/**",
    ".claude/**",
  ],
});
