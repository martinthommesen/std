import { defineConfig } from "vitest/config";

// The compose smoke test (test/compose-smoke): Chromium against a stack
// already running from `docker compose up`, at STD_URL (default
// http://127.0.0.1:8080). It builds nothing and starts no server or
// database; `.github/workflows/quickstart-compose.yml` runs it with
// `pnpm --filter @std/web exec vitest run --config vitest-compose-smoke.config.ts`.
const TIMEOUT_MS = 120_000;

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: TIMEOUT_MS,
    include: ["test/compose-smoke/**/*.test.ts"],
    name: "@std/web compose smoke",
    testTimeout: TIMEOUT_MS,
  },
});
