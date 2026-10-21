import { defineConfig } from "vitest/config";

// `pnpm test:canaries`: the Contracts 9 acceptance tests for the toolchain.
// They spawn `tsc` and the tooling checks against the fixture packages in
// `tooling/canaries/`, and one of them unpatches and repatches TypeScript, so
// test files run one at a time.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    root: import.meta.dirname,
    testTimeout: 120_000,
  },
});
