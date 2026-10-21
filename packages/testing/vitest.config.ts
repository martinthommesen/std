import { defineConfig } from "vitest/config";

// Suites share the Postgres server with other runs, so creating a database
// (in setup hooks and in the harness's own tests) can be slow under load.
const TEST_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    hookTimeout: HOOK_TIMEOUT_MS,
    include: ["test/**/*.test.ts"],
    name: "@std/testing",
    testTimeout: TEST_TIMEOUT_MS,
  },
});
