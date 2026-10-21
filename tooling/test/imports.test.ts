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
const bypassDir = fixture("plain-bypass");
const bypassModules = path.join(bypassDir, "node_modules");
const srcModules = path.join(bypassDir, "src", "node_modules");
const bridge = path.join(bypassDir, "src", "bridge");

const problemsFor = (result: CommandResult | undefined, file: string): string =>
  (result?.output ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.startsWith(`tooling/canaries/plain-bypass/src/${file}:`) ||
        line.startsWith(`tooling/canaries/plain-bypass/src/${file} `)
    )
    .join("\n");

// Writes an installed package into the fixture's node_modules.
const installPackage = (
  name: string,
  dependencies: Readonly<Record<string, Readonly<Record<string, string>>>> = {}
): void => {
  mkdirSync(path.join(bypassModules, name), { recursive: true });
  writeFileSync(
    path.join(bypassModules, name, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", ...dependencies })}\n`
  );
};

// What an install would leave: an npm alias of effect, a package that
// depends on effect, one that reaches it through an aliased transitive
// dependency, one with an optional @effect dependency, and a clean package
// whose graph has a cycle; plus a node_modules directory inside src/ and a
// symlink to it.
const writeInstall = (): void => {
  mkdirSync(bypassModules, { recursive: true });
  symlinkSync(
    realpathSync(path.join(repoRoot, "node_modules", "effect")),
    path.join(bypassModules, "fx")
  );
  installPackage("fx-wrapper", { dependencies: { effect: "4.0.5" } });
  installPackage("allowed-wrapper", { dependencies: { inner: "1.0.0" } });
  installPackage("inner", {
    dependencies: { "not-effect": "npm:effect@4.0.5" },
  });
  installPackage("optional-wrapper", {
    optionalDependencies: { "@effect/platform-node": "4.0.5" },
  });
  installPackage("clean-lib", { dependencies: { "clean-helper": "1.0.0" } });
  installPackage("clean-helper", { dependencies: { "clean-lib": "1.0.0" } });
  installPackage("unlisted-lib");
  mkdirSync(srcModules, { recursive: true });
  writeFileSync(
    path.join(srcModules, "hidden.ts"),
    'export { Effect as hidden } from "effect";\n'
  );
  symlinkSync("node_modules", bridge);
};

describe("plain-import-check", () => {
  let bypass: CommandResult | undefined;

  beforeAll(async () => {
    writeInstall();
    bypass = await runTool("check-imports.ts", [
      "--allowed-deps",
      path.join(bypassDir, "allowed-deps.json"),
      bypassDir,
      fixture("plain-tests"),
      fixture("server-sql"),
    ]);
  });

  afterAll(() => {
    for (const dir of [bypassModules, srcModules, bridge]) {
      rmSync(dir, { force: true, recursive: true });
    }
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

  it("allows Schema modules, own src/ files, plain packages and clean allow-listed packages", () => {
    expect(bypass?.code).toBe(1);
    expect(
      [
        "allowed.ts",
        "sibling-plain.ts",
        "inner/label.ts",
        "allowed-dependency.ts",
      ]
        .map((file) => problemsFor(bypass, file))
        .join("")
    ).toBe("");
  });

  it("fails a relative path into node_modules and a re-export outside src/", () => {
    expect(problemsFor(bypass, "relative-node-modules.ts")).toContain(
      "outside this package's src/"
    );
    expect(problemsFor(bypass, "test-helper.ts")).toContain(
      '"../test/helpers.ts" resolves to test/helpers.ts, outside'
    );
  });

  it("fails a symlink in src/, a node_modules directory in src/, and imports through them", () => {
    expect(problemsFor(bypass, "bridge")).toContain(
      "symlinks are not allowed in a plain package's src/"
    );
    expect(problemsFor(bypass, "node_modules")).toContain(
      "node_modules is not allowed in a plain package's src/"
    );
    expect(problemsFor(bypass, "via-bridge.ts")).toContain(
      "not a source file the check scans"
    );
  });

  it("fails package imports (#) that lead to Effect or outside src/", () => {
    expect(problemsFor(bypass, "package-imports.ts")).toContain(
      '"#fx" maps to "effect/Effect"'
    );
    expect(problemsFor(bypass, "package-imports-outside.ts")).toContain(
      '"#helpers" maps to test/helpers.ts, outside'
    );
  });

  it("fails third-party packages that are not allow-listed or reach Effect", () => {
    expect(problemsFor(bypass, "unlisted.ts")).toContain(
      "unlisted-lib is not in tooling/plain-allowed-deps.json"
    );
    expect(problemsFor(bypass, "alias.ts")).toContain('"fx" installs effect');
    expect(problemsFor(bypass, "wrapper.ts")).toContain(
      "depends on Effect (fx-wrapper -> effect)"
    );
    expect(problemsFor(bypass, "transitive.ts")).toContain(
      "depends on Effect (allowed-wrapper -> inner -> not-effect (effect))"
    );
    expect(problemsFor(bypass, "optional.ts")).toContain(
      "depends on Effect (optional-wrapper -> @effect/platform-node)"
    );
  });

  it("fails a non-plain workspace package and exports outside a plain package's src/", () => {
    expect(problemsFor(bypass, "sibling-server.ts")).toContain(
      'has the "server" profile'
    );
    expect(problemsFor(bypass, "sibling-outside.ts")).toContain(
      "does not map to a source file in @std-canary/plain-tests's src/"
    );
  });

  it("fails dynamic imports, literal or computed, and an escaped specifier", () => {
    expect(problemsFor(bypass, "dynamic-literal.ts")).toContain(
      '"effect/Effect" is not allowed in a plain package'
    );
    expect(problemsFor(bypass, "dynamic-template.ts")).toContain(
      "import() with a computed specifier"
    );
    expect(problemsFor(bypass, "dynamic-identifier.ts")).toContain(
      "import() with a computed specifier"
    );
    expect(problemsFor(bypass, "escaped.ts")).toContain(
      'Effect from "effect" is not allowed'
    );
  });

  it("fails Node built-ins, named or aliased, bare or node:", () => {
    expect(problemsFor(bypass, "create-require.ts")).toContain(
      '"node:module" is a Node built-in'
    );
    expect(problemsFor(bypass, "builtin-named.ts")).toContain(
      '"node:process" is a Node built-in'
    );
    expect(problemsFor(bypass, "builtin-alias.ts")).toContain(
      '"process" is a Node built-in'
    );
  });

  it("fails host globals by destructuring or computed access, import.meta and .constructor", () => {
    expect(problemsFor(bypass, "global-destructure.ts")).toContain(
      '"process" is not allowed in a plain package'
    );
    expect(problemsFor(bypass, "global-computed.ts")).toContain(
      '"globalThis" is not allowed in a plain package'
    );
    expect(problemsFor(bypass, "import-meta.ts")).toContain(
      "import.meta is not allowed in a plain package"
    );
    expect(problemsFor(bypass, "function-constructor.ts")).toContain(
      ".constructor is not allowed in a plain package"
    );
  });

  it("fails constructor reads by destructuring, nested or assignment patterns", () => {
    expect(
      [
        "constructor-destructure.ts",
        "constructor-nested.ts",
        "constructor-assignment.ts",
      ].map((file) =>
        problemsFor(bypass, file).includes(".constructor is not allowed")
      )
    ).toStrictEqual([true, true, true]);
  });

  it("fails constructor reads by template or string keys", () => {
    expect(
      [
        "constructor-template.ts",
        "constructor-computed-pattern.ts",
        "constructor-reflect.ts",
      ].map((file) =>
        problemsFor(bypass, file).includes(".constructor is not allowed")
      )
    ).toStrictEqual([true, true, true]);
  });
});
