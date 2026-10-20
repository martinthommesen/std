import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixture, runTool, runTsc } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": each profile's allow list, enforced by the
// patched tsc with Effect diagnostics as errors.
describe("effect-stability-diagnostics", () => {
  it("fails effect/sql in a plain package", async () => {
    const result = await runTsc("plain-sql");

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "`effect/sql/SqlClient#SqlClient` is an unstable API"
    );
    expect(result.output).toContain("effect(unstableApiUsage)");
  });

  it("passes the same effect/sql import in a server package, and @effect/vitest in its tests", async () => {
    const result = await runTsc("server-sql");

    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  });

  it("lets a plain package's tests use the server modules and @effect/vitest", async () => {
    const result = await runTsc("plain-tests");

    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  });

  it("type-checks HttpApiClient.make in the web and api profiles", async () => {
    const results = await Promise.all([
      runTsc("web-client"),
      runTsc("api-client"),
    ]);

    expect(results.map((result) => [result.code, result.output])).toStrictEqual(
      [
        [0, ""],
        [0, ""],
      ]
    );
  });

  it("fails effect/sql in the web profile", async () => {
    const result = await runTsc("web-sql");

    expect(result.code).toBe(1);
    expect(result.output).toContain("effect(unstableApiUsage)");
  });

  it("fails an Effect 3-era API with outdatedApi", async () => {
    const result = await runTsc("outdated");

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "uses the Effect v3 API `catchAll`. The referenced API belongs to the v3 surface rather than the configured v4 surface. Renamed to catch. effect(outdatedApi)"
    );
  });

  it("keeps every fixture's tsconfig on its declared profile", async () => {
    const result = await runTool("check-tsconfig.ts", [
      fixture("plain-sql"),
      fixture("server-sql"),
      fixture("plain-tests"),
      fixture("plain-effect"),
      fixture("web-client"),
      fixture("api-client"),
      fixture("web-sql"),
      fixture("outdated"),
      fixture("duplicate"),
    ]);

    expect(result.output).toBe(
      "check-tsconfig: 9 package(s) match their profiles\n"
    );
    expect(result.code).toBe(0);
  });

  it("fails a tsconfig whose allow list drifts from its profile", async () => {
    const result = await runTool("check-tsconfig.ts", [
      fixture("tsconfig-drift"),
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      'tooling/canaries/tsconfig-drift/tsconfig.json: compilerOptions.plugins does not match the "plain" profile'
    );
  });
});

describe("effect-duplicate-package", () => {
  const secondCopy = path.join(
    fixture("duplicate"),
    "second",
    "node_modules",
    "effect"
  );

  beforeAll(() => {
    mkdirSync(secondCopy, { recursive: true });
    writeFileSync(
      path.join(secondCopy, "package.json"),
      JSON.stringify({
        exports: { ".": { types: "./index.d.ts" } },
        name: "effect",
        type: "module",
        types: "./index.d.ts",
        version: "4.0.4",
      })
    );
    writeFileSync(
      path.join(secondCopy, "index.d.ts"),
      "export declare const secondCopy: number;\n"
    );
  });

  afterAll(() => {
    rmSync(path.join(fixture("duplicate"), "second", "node_modules"), {
      force: true,
      recursive: true,
    });
  });

  it("fails a second copy of effect with duplicatePackage", async () => {
    const result = await runTsc("duplicate");

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "Multiple versions of package `effect` were detected: 4.0.5"
    );
    expect(result.output).toContain("effect(duplicatePackage)");
  });
});
