import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // vendor/ holds Effect's upstream source, kept byte-for-byte as published.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "vendor/**"],
});
