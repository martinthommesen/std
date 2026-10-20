import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, runTool } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": the CI checks that the stability
// diagnostics cannot do on their own.
describe("plain-import-check", () => {
  it("fails a stable Effect import in a plain package", async () => {
    const result = await runTool("check-imports.ts", [fixture("plain-effect")]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'tooling/canaries/plain-effect/src/program.ts:1:10: Effect from "effect" is not allowed in a plain package'
    );
  });

  it("passes Schema and Option in a plain package, and ignores its tests", async () => {
    const result = await runTool("check-imports.ts", [fixture("plain-tests")]);

    expect(result.output).toBe(
      "check-imports: 1 file(s) in 1 plain package(s) import only Schema from Effect\n"
    );
    expect(result.code).toBe(0);
  });

  it("skips packages that are not plain", async () => {
    const result = await runTool("check-imports.ts", [fixture("server-sql")]);

    expect(result.code).toBe(0);
  });
});

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

describe("vendored-effect-check", () => {
  it("passes the vendored source", async () => {
    const result = await runTool("check-vendor.ts");

    expect(result.output).toContain("vendor/effect is effect@4.0.5");
    expect(result.code).toBe(0);
  });

  it("fails when the vendored tag differs from the lockfile", async () => {
    const result = await runTool("check-vendor.ts", [
      "--root",
      fixture("vendor-mismatch"),
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "vendor record: tag effect@4.0.4, but the lockfile needs effect@4.0.5"
    );
    expect(result.output).toContain("effect@4.0.4, expected effect@4.0.5");
  });
});
