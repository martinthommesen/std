import { defineProject } from "vitest/config";

// Foldkit's story and scene tests, beside the code they drive. The browser
// tests run on their own (vitest-browser.config.ts).
export default defineProject({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "test/*.test.ts"],
    name: "@std/web",
    server: {
      deps: { inline: ["foldkit", "@foldkit/ui", "@foldkit/devtools"] },
    },
    setupFiles: ["./src/vitest-setup.ts"],
  },
});
