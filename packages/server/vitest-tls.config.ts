import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 120_000,
    include: ["packages/server/test/postgres-tls.integration.ts"],
    testTimeout: 120_000,
  },
});
