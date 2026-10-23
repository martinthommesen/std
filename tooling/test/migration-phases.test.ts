import { readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { fixture, runTool } from "./run-tools.ts";

const canary = (name: string): string =>
  path.join(fixture("migration-phases"), `${name}.json`);

const runCanary = async (name: string) =>
  await runTool("check-migration-phases.ts", ["--migrations", canary(name)]);

const Expectations = Schema.Struct({
  PLATFORM_MIGRATIONS: Schema.Array(
    Schema.Struct({
      expectedProblems: Schema.Array(Schema.NonEmptyString),
      expectedStatement: Schema.optionalKey(Schema.Int),
      extraProblems: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            message: Schema.NonEmptyString,
            statement: Schema.Int,
          })
        )
      ),
      id: Schema.Int,
    })
  ),
});

describe("migration-phases", () => {
  it("checks the registered migrations and their file inventory", async () => {
    const result = await runTool("check-migration-phases.ts");
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      "migration-phases: every migration declares a phase; expand SQL passes the conservative check\n"
    );
  });

  it.each(["allowed", "contract", "historical"])(
    "accepts %s SQL",
    async (name) => {
      const result = await runCanary(name);
      expect(result.code).toBe(0);
      expect(result.output).toBe(
        "migration-phases: every migration declares a phase; expand SQL passes the conservative check\n"
      );
    }
  );

  it.each(["refused", "ast-rules", "historical-altered"])(
    "checks every exact diagnostic and acceptance in %s",
    async (name) => {
      const result = await runCanary(name);
      expect(result.code).toBe(1);

      const { PLATFORM_MIGRATIONS } = Schema.decodeUnknownSync(Expectations)(
        JSON.parse(readFileSync(canary(name), "utf-8"))
      );

      const expected = PLATFORM_MIGRATIONS.flatMap(
        ({
          id,
          expectedProblems,
          expectedStatement = 1,
          extraProblems = [],
        }) => [
          ...expectedProblems.map(
            (problem) => `${id} statement ${expectedStatement}: ${problem}`
          ),
          ...extraProblems.map(
            ({ statement, message }) =>
              `${id} statement ${statement}: ${message}`
          ),
        ]
      );

      expect(result.output).toBe(
        `${expected.join("\n")}\nmigration-phases: ${expected.length} problems\n`
      );
    }
  );

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
