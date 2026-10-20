import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { fixture, runTool } from "./run-tools.ts";

// Contracts 9, "Acceptance tests": a canary import of Effect into a plain
// package fails the CI import check, by any route.
const bypassModules = path.join(fixture("plain-bypass"), "node_modules");

const problemsFor = (
  result: CommandResult | undefined,
  file: string
): string[] =>
  (result?.output ?? "")
    .split("\n")
    .filter((line) =>
      line.startsWith(`tooling/canaries/plain-bypass/src/${file}:`)
    );

describe("plain-import-check", () => {
  let bypass: CommandResult | undefined;

  beforeAll(async () => {
    // An npm alias of effect and a package that depends on it, as an
    // install would leave them.
    mkdirSync(path.join(bypassModules, "fx-wrapper"), { recursive: true });
    symlinkSync(
      realpathSync(path.join(repoRoot, "node_modules", "effect")),
      path.join(bypassModules, "fx")
    );
    writeFileSync(
      path.join(bypassModules, "fx-wrapper", "package.json"),
      '{ "name": "fx-wrapper", "version": "1.0.0", "dependencies": { "effect": "4.0.5" } }\n'
    );
    bypass = await runTool("check-imports.ts", [
      fixture("plain-bypass"),
      fixture("plain-tests"),
      fixture("server-sql"),
    ]);
  });

  afterAll(() => {
    rmSync(bypassModules, { force: true, recursive: true });
  });

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

  it("allows Schema modules, files inside src/ and another plain package's src/", () => {
    expect(bypass?.code).toBe(1);
    expect([
      ...problemsFor(bypass, "allowed.ts"),
      ...problemsFor(bypass, "sibling-plain.ts"),
      ...problemsFor(bypass, "inner/label.ts"),
    ]).toStrictEqual([]);
  });

  it("fails a relative path into node_modules", () => {
    expect(
      problemsFor(bypass, "relative-node-modules.ts").join("\n")
    ).toContain("resolves outside this package's src/");
  });

  it("fails a re-export through a file outside src/", () => {
    expect(problemsFor(bypass, "test-helper.ts").join("\n")).toContain(
      '"../test/helpers.ts" resolves outside this package\'s src/'
    );
  });

  it("fails package imports (#) that lead to Effect or outside src/", () => {
    expect(problemsFor(bypass, "package-imports.ts").join("\n")).toContain(
      '"#fx" maps to "effect/Effect"'
    );
    expect(
      problemsFor(bypass, "package-imports-outside.ts").join("\n")
    ).toContain('"#helpers" maps to ./test/helpers.ts, outside');
  });

  it("fails an npm alias of effect and a package that depends on Effect", () => {
    expect(problemsFor(bypass, "alias.ts").join("\n")).toContain(
      '"fx" is effect: succeed from "effect" is not allowed'
    );
    expect(problemsFor(bypass, "wrapper.ts").join("\n")).toContain(
      '"fx-wrapper" depends on effect'
    );
  });

  it("fails a non-plain workspace package and exports outside a plain package's src/", () => {
    expect(problemsFor(bypass, "sibling-server.ts").join("\n")).toContain(
      'has the "server" profile'
    );
    expect(problemsFor(bypass, "sibling-outside.ts").join("\n")).toContain(
      "does not map into @std-canary/plain-tests's src/"
    );
  });

  it("fails dynamic imports, literal or computed", () => {
    expect(problemsFor(bypass, "dynamic-literal.ts").join("\n")).toContain(
      '"effect/Effect" is not allowed in a plain package'
    );
    expect(problemsFor(bypass, "dynamic-template.ts").join("\n")).toContain(
      "import() with a computed specifier"
    );
    expect(problemsFor(bypass, "dynamic-identifier.ts").join("\n")).toContain(
      "import() with a computed specifier"
    );
  });

  it("fails an escaped specifier and createRequire", () => {
    expect(problemsFor(bypass, "escaped.ts").join("\n")).toContain(
      'Effect from "effect" is not allowed'
    );
    expect(problemsFor(bypass, "create-require.ts").join("\n")).toContain(
      '"node:module" can load modules around this check'
    );
  });
});
