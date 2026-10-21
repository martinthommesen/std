import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";
import { fixture } from "./run-tools.ts";

// docs/decisions/0010-foldkit-tooling.md: the root oxlint.config.ts runs the
// Foldkit plugin's "all" preset on apps/web only. Override globs resolve from
// the config's directory, so the canary lints one fixture file at
// apps/web/src and at packages/server/src of a temporary tree whose
// oxlint.config.ts re-exports the root config unchanged. JS plugins resolve
// from the config's directory, so the tree links the root node_modules.
const temporary = mkdtempSync(path.join(tmpdir(), "std-foldkit-lint-"));
const source = path.join(fixture("foldkit-lint"), "counter.ts");
const webFile = "apps/web/src/counter.ts";
const serverFile = "packages/server/src/counter.ts";
const webTestFile = "apps/web/src/counter.test.ts";

for (const file of [webFile, serverFile, webTestFile]) {
  mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
  copyFileSync(source, path.join(temporary, file));
}

symlinkSync(
  path.join(repoRoot, "node_modules"),
  path.join(temporary, "node_modules")
);

writeFileSync(
  path.join(temporary, "oxlint.config.ts"),
  `export { default } from ${JSON.stringify(path.join(repoRoot, "oxlint.config.ts"))};\n`
);

const foldkitRules = (output: string, file: string): string[] =>
  output
    .split("\n")
    .filter((line) => line.startsWith(`${file}:`))
    .flatMap(
      (line) => /foldkit\((?<rule>[a-z-]+)\)/u.exec(line)?.groups?.rule ?? []
    )
    .toSorted();

const lint = async (files: readonly string[]) =>
  await runCommand(
    path.join(repoRoot, "node_modules", ".bin", "oxlint"),
    ["-c", path.join(temporary, "oxlint.config.ts"), ...files],
    { cwd: temporary }
  );

describe("foldkit-oxlint-scope", () => {
  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it("passes the fixture under the repository's own lint", async () => {
    const result = await runCommand(
      path.join(repoRoot, "node_modules", ".bin", "oxlint"),
      [path.relative(repoRoot, source)],
      { cwd: repoRoot }
    );

    expect(result.output).not.toContain("foldkit(");
    expect(result.code).toBe(0);
  });

  it("fires Foldkit rules on apps/web and none on packages/server", async () => {
    const result = await lint([webFile, serverFile]);

    expect(foldkitRules(result.output, webFile)).toStrictEqual([
      "no-module-level-mutable-state",
      "no-switch-on-message-tag",
    ]);
    expect(foldkitRules(result.output, serverFile)).toStrictEqual([]);
    expect(result.code).toBe(1);
  });

  it("applies the preset's own test-file override inside apps/web", async () => {
    const result = await lint([webTestFile]);

    expect(foldkitRules(result.output, webTestFile)).toStrictEqual([
      "no-switch-on-message-tag",
    ]);
  });

  it("passes the packages/server copy on its own", async () => {
    const result = await lint([serverFile]);

    expect(result.output).not.toContain("foldkit(");
    expect(result.code).toBe(0);
  });
});
