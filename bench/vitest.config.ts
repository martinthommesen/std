import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 600_000,
    include: ["test/**/*.test.ts"],
    name: "bench",
    testTimeout: 600_000,
  },
});
