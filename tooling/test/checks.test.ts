import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, runTool } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": a second copy of effect in the lockfile
// fails CI.
const lockfileArgs = (name: string): string[] => [
  "--lockfile",
  path.join(fixture(name), "pnpm-lock.yaml"),
  "--workspace",
  path.join(fixture(name), "pnpm-workspace.yaml"),
];

describe("effect-lockfile-check", () => {
  it("passes the repository lockfile", async () => {
    const result = await runTool("check-lockfile.ts");

    expect(result.code).toBe(0);
  });

  it("fails a second copy of effect and an @effect package off the catalog version", async () => {
    const result = await runTool(
      "check-lockfile.ts",
      lockfileArgs("lockfile-duplicate")
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "effect: resolved to 4.0.4, 4.0.5; expected exactly 4.0.5"
    );
    expect(result.output).toContain(
      "@effect/sql-pg: resolved to 4.0.4; expected exactly 4.0.5"
    );
  });

  it("fails @effect/sql and @effect/platform", async () => {
    const result = await runTool(
      "check-lockfile.ts",
      lockfileArgs("lockfile-forbidden")
    );

    expect(result.code).toBe(1);
    expect(result.output).toContain("@effect/sql: must not be installed");
    expect(result.output).toContain("@effect/platform: must not be installed");
  });
});
