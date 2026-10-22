import { defineConfig } from "vitest/config";

// The browser tests (decision 0018): Playwright's Chromium against a real
// `std serve` on a disposable database. They need Postgres, as every
// database test does, and Chromium (`playwright install chromium`); the
// global setup refuses to start without it and says how to install it.
const TIMEOUT_MS = 180_000;

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["./test/browser/global-setup.ts"],
    hookTimeout: TIMEOUT_MS,
    include: ["test/browser/**/*.test.ts"],
    name: "@std/web browser",
    testTimeout: TIMEOUT_MS,
  },
});
