import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandResult } from "../lib/run.ts";
import { fixture, runTool } from "./run-tools.ts";

// Contracts 15, "Acceptance tests": the requirements-matrix check against a
// clean fixture (tooling/canaries/conformance-matrix) and copies of it with
// one thing broken each.
const temporaryDirs: string[] = [];

const copyFixture = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "std-matrix-"));

  temporaryDirs.push(dir);
  cpSync(fixture("conformance-matrix"), dir, { recursive: true });

  return dir;
};

const edit = (dir: string, file: string, from: string, to: string): void => {
  const target = path.join(dir, file);
  const text = readFileSync(target, "utf-8");

  if (!text.includes(from)) {
    throw new Error(`${file} does not contain ${from}`);
  }

  writeFileSync(target, text.replace(from, to));
};

const check = async (
  dir: string,
  extra: readonly string[] = []
): Promise<CommandResult> =>
  await runTool("check-conformance-matrix.ts", [
    "--pins",
    path.join(dir, "pins.json"),
    "--matrix-dir",
    path.join(dir, "matrix"),
    "--root",
    dir,
    ...extra,
  ]);

const pendingRow = [
  "  - id: DEMO-A@1.0.0/DOC/4/pending",
  "    source: Demo document 1.0.0 §4 p.3",
  "    level: mandatory",
  "    requirement: Not tested yet.",
  "    status: pending",
  "",
].join("\n");

// Points the excluded row at another decision, listed in that decision's rows.
const excludeBy = (dir: string, decision: string): void => {
  edit(
    dir,
    "matrix/DEMO-A@1.0.0.yaml",
    "decision: D1-accepted",
    `decision: ${decision}`
  );
  edit(
    dir,
    "matrix/decisions.yaml",
    "    rows:\n      - DEMO-A@1.0.0/DOC/3/excluded\n",
    "    rows: []\n"
  );
  edit(
    dir,
    "matrix/decisions.yaml",
    `  - id: ${decision}\n    rows: []`,
    `  - id: ${decision}\n    rows:\n      - DEMO-A@1.0.0/DOC/3/excluded`
  );
};

describe("conformance-matrix-check", () => {
  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("passes a clean matrix with an accepted exclusion, also in gate mode up to its last written step", async () => {
    const dir = copyFixture();
    const plain = await check(dir);
    const gated = await check(dir, ["--gate", "step4"]);

    expect(plain.code).toBe(0);
    expect(plain.output).toContain(
      "AWAITED@v1.yaml: not written yet (awaited from workstream 9Z)"
    );
    expect(plain.output).toContain("2 matrix file(s), 5 row(s)");
    expect(gated.code).toBe(0);
    expect(gated.output).toContain("gate step4 passed");
  });

  it("fails a missing test file", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/DEMO-B@2.0.yaml",
      "sample-tests.ts#reads rows",
      "missing.test.ts#reads rows"
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain("test file missing.test.ts does not exist");
  });

  it("fails a misspelt title, and a title only an it.skip has", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/DEMO-B@2.0.yaml",
      "sample-tests.ts#reads rows",
      "sample-tests.ts#read rows"
    );
    edit(
      dir,
      "matrix/DEMO-A@1.0.0.yaml",
      "sample-tests.ts#counts rows\n",
      "sample-tests.ts#a skipped case\n"
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain('has the title "read rows"');
    expect(result.output).toContain('has the title "a skipped case"');
  });

  it("fails an unknown decision", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/DEMO-A@1.0.0.yaml",
      "decision: D1-accepted",
      "decision: D9-unknown"
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "names decision D9-unknown, which the decision log does not have"
    );
  });

  it("fails a pending row in gate mode only", async () => {
    const dir = copyFixture();

    edit(dir, "matrix/DEMO-A@1.0.0.yaml", "rows:\n", `rows:\n${pendingRow}`);

    const plain = await check(dir);
    const gated = await check(dir, ["--gate", "step3"]);

    expect(plain.code).toBe(0);
    expect(gated.code).toBe(1);
    expect(gated.output).toContain(
      "step3: DEMO-A@1.0.0.yaml: row DEMO-A@1.0.0/DOC/4/pending is pending"
    );
  });

  it("fails a proposed decision in gate mode", async () => {
    const dir = copyFixture();

    excludeBy(dir, "D2-proposed");

    const result = await check(dir, ["--gate", "step3"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "excluded by D2-proposed, which Martin has not decided"
    );
  });

  it("fails a rejected decision in gate mode", async () => {
    const dir = copyFixture();

    excludeBy(dir, "D3-rejected");

    const result = await check(dir, ["--gate", "step3"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "excluded by D3-rejected, which Martin rejected; it needs a test"
    );
  });

  it("fails a decided decision without an outcome", async () => {
    const dir = copyFixture();

    edit(dir, "matrix/decisions.yaml", "    outcome: accepted\n", "");

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "decisions.yaml: does not match its schema"
    );
  });

  it("fails a pin that differs from pins.json", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/DEMO-A@1.0.0.yaml",
      "version: 1.0.0\ntitle",
      "version: 1.0.1\ntitle"
    );
    cpSync(
      path.join(dir, "matrix", "DEMO-B@2.0.yaml"),
      path.join(dir, "matrix", "DEMO-B@2.1.yaml")
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "DEMO-A@1.0.0.yaml: declares DEMO-A@1.0.1, but pins.json pins DEMO-A@1.0.0"
    );
    expect(result.output).toContain(
      "DEMO-B@2.1.yaml: not a pinned specification"
    );
  });

  it("fails a duplicate id", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/DEMO-A@1.0.0.yaml",
      "id: DEMO-A@1.0.0/DOC/2/template",
      "id: DEMO-A@1.0.0/DOC/1/count"
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "row id DEMO-A@1.0.0/DOC/1/count appears more than once"
    );
  });

  it("fails a pinned specification without a file, and an awaited one in its gate", async () => {
    const dir = copyFixture();

    rmSync(path.join(dir, "matrix", "DEMO-B@2.0.yaml"));

    const missing = await check(dir);
    const awaited = await check(copyFixture(), ["--gate", "step5"]);

    expect(missing.code).toBe(1);
    expect(missing.output).toContain(
      "DEMO-B@2.0.yaml: pins.json pins DEMO-B@2.0, but the file is missing"
    );
    expect(awaited.code).toBe(1);
    expect(awaited.output).toContain(
      "step5: AWAITED@v1.yaml is missing or invalid"
    );
  });

  it("fails a decision that lists a row it does not exclude", async () => {
    const dir = copyFixture();

    edit(
      dir,
      "matrix/decisions.yaml",
      "      - DEMO-A@1.0.0/DOC/3/excluded\n",
      "      - DEMO-A@1.0.0/DOC/3/excluded\n      - DEMO-A@1.0.0/DOC/1/count\n"
    );

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "D1-accepted lists row DEMO-A@1.0.0/DOC/1/count, which it does not exclude"
    );
  });

  it("passes the repository's matrix outside gate mode", async () => {
    const result = await runTool("check-conformance-matrix.ts");

    expect(result.code).toBe(0);
  });
});
