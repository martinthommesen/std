import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["test/**/*.test.ts"],
    name: "values",
    testTimeout: 60_000,
  },
});
