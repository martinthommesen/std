import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, runTool } from "./run-tools.ts";

const canary = (name: string): string =>
  path.join(fixture("migration-phases"), `${name}.json`);

const runCanary = async (name: string) =>
  await runTool("check-migration-phases.ts", ["--migrations", canary(name)]);

describe("migration-phases", () => {
  it("checks the registered migrations and their file inventory", async () => {
    const result = await runTool("check-migration-phases.ts");
    expect(result.code).toBe(0);
    expect(result.output).toContain("every migration declares a phase");
  });

  it.each(["allowed", "contract"])("accepts %s SQL", async (name) => {
    const result = await runCanary(name);
    expect(result.code).toBe(0);
  });

  it("refuses every destructive, rewriting or unsupported SQL canary", async () => {
    const result = await runCanary("refused");
    expect(result.code).toBe(1);

    const count = (
      readFileSync(canary("refused"), "utf-8").match(/"id":/gu) ?? []
    ).length;

    for (let index = 0; index < count; index += 1) {
      expect(result.output).toContain(`${index + 17} statement 1:`);
    }
  });

  it("requires a recognized phase for every migration kind", async () => {
    const result = await runCanary("phases");
    expect(result.code).toBe(1);

    for (const id of [17, 18, 19, 20, 21, 22]) {
      expect(result.output).toContain(`${id}: missing or unknown phase`);
    }
  });

  it("remembers function names from earlier contract migrations", async () => {
    const result = await runCanary("functions");
    expect(result.code).toBe(1);
    expect(result.output).toContain("18 statement 1: existing function name");
  });

  it("reports malformed input and read failures with exit 1", async () => {
    const malformed = await runCanary("malformed");
    expect(malformed.code).toBe(1);
    expect(malformed.output).toContain("migration-phases:");
    const missing = await runCanary("missing");
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("migration-phases: ENOENT");
  });
});
