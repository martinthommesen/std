import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // Database setup hooks create a fresh database, which is slow when several
    // suites run against the same server at once.
    hookTimeout: 120_000,
    include: ["test/**/*.test.ts"],
    name: "conditions",
    testTimeout: 120_000,
  },
});
