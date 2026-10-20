import { defineConfig } from "vitest/config";

const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    hookTimeout: HOOK_TIMEOUT_MS,
    include: ["test/**/*.test.ts"],
    name: "@std/server",
    testTimeout: TEST_TIMEOUT_MS,
  },
});
