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

  // One edit of the clean fixture each, and the problem it must report.
  const singleEdits = [
    {
      case: "a missing test file",
      file: "matrix/DEMO-B@2.0.yaml",
      from: "sample-tests.ts#reads rows",
      problem: "test file missing.test.ts does not exist",
      to: "missing.test.ts#reads rows",
    },
    {
      case: "a test file that shadows vitest's it",
      file: "sample-tests.ts",
      from: 'describe("effect-rows", () => {',
      problem: "test file sample-tests.ts cannot be read: declares its own it",
      to: 'describe("effect-rows", () => {\n  const it = { effect: (title: string): string => title };\n',
    },
    {
      case: "a test file that shadows it with a destructured name",
      file: "sample-tests.ts",
      from: 'describe("effect-rows", () => {',
      problem: "test file sample-tests.ts cannot be read: declares its own it",
      to: 'describe("effect-rows", () => {\n  const { noop: it } = { noop: (title: string): string => title };\n',
    },
    {
      case: "a test file that shadows it with a parameter",
      file: "sample-tests.ts",
      from: 'describe("effect-rows", () => {',
      problem: "test file sample-tests.ts cannot be read: declares its own it",
      to: 'describe("effect-rows", () => {\n  const run = (it: (title: string) => string): string => it("phantom");\n',
    },
    {
      case: "a test file that uses a computed member that is not a string literal",
      file: "sample-tests.ts",
      from: 'describe("effect-rows", () => {',
      problem:
        "test file sample-tests.ts cannot be read: uses a computed member on describe",
      to: 'const key = "skip";\ndescribe[key]("dynamic", () => {});\ndescribe("effect-rows", () => {',
    },
    {
      case: "a JSON pointer that does not resolve in the pinned OpenAPI document",
      file: "matrix/DEMO-A@1.0.0.yaml",
      from: "#/components/schemas/Thing/required",
      problem:
        "#/components/schemas/Thing_FVO/required does not resolve in demo.oas.json",
      to: "#/components/schemas/Thing_FVO/required",
    },
    {
      case: "an unknown decision",
      file: "matrix/DEMO-A@1.0.0.yaml",
      from: "decision: D1-accepted",
      problem:
        "names decision D9-unknown, which the decision log does not have",
      to: "decision: D9-unknown",
    },
    {
      case: "a decided decision without an outcome",
      file: "matrix/decisions.yaml",
      from: "    outcome: accepted\n",
      problem: "decisions.yaml: does not match its schema",
      to: "",
    },
    {
      case: "a duplicate id",
      file: "matrix/DEMO-A@1.0.0.yaml",
      from: "id: DEMO-A@1.0.0/DOC/2/template",
      problem: "row id DEMO-A@1.0.0/DOC/1/count appears more than once",
      to: "id: DEMO-A@1.0.0/DOC/1/count",
    },
  ] as const;

  it.each(singleEdits)("fails $case", async ({ file, from, problem, to }) => {
    const dir = copyFixture();

    edit(dir, file, from, to);

    const result = await check(dir);

    expect(result.code).toBe(1);
    expect(result.output).toContain(problem);
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

  it("fails titles of tests that do not run or are not vitest's", async () => {
    const dir = copyFixture();

    // Written here, not committed: lint would rewrite the computed member.
    writeFileSync(
      path.join(dir, "structures.ts"),
      [
        'import { describe, expect, it } from "vitest";',
        'describe["skip"]("a computed skipped block", () => {',
        '  it("a case in a computed skipped block", () => {',
        "    expect([1]).toHaveLength(1);",
        "  });",
        "});",
        "if (process.env.FLAG) {",
        '  it("a conditional case", () => {',
        "    expect([1]).toHaveLength(1);",
        "  });",
        "}",
        "const helper = () => {",
        '  it("a case in a helper", () => {',
        "    expect([1]).toHaveLength(1);",
        "  });",
        "};",
        "helper();",
        'describe("a counted block", () => {',
        '  it("a counted case", () => {',
        "    expect([1]).toHaveLength(1);",
        "  });",
        "});",
        "",
      ].join("\n")
    );

    edit(
      dir,
      "matrix/DEMO-B@2.0.yaml",
      "      - sample-tests.ts#reads rows\n",
      [
        "      - sample-tests.ts#reads rows",
        "      - sample-tests.ts#a case without a body",
        "      - sample-tests.ts#a skipped block",
        "      - sample-tests.ts#a case in a skipped block",
        "      - local-it.ts#a local case",
        "      - structures.ts#a computed skipped block",
        "      - structures.ts#a case in a computed skipped block",
        "      - structures.ts#a conditional case",
        "      - structures.ts#a case in a helper",
        "      - structures.ts#a counted case",
        "",
      ].join("\n")
    );

    const result = await check(dir);

    expect(result.code).toBe(1);

    for (const title of [
      "a case without a body",
      "a skipped block",
      "a case in a skipped block",
      "a local case",
      "a computed skipped block",
      "a case in a computed skipped block",
      "a conditional case",
      "a case in a helper",
    ]) {
      expect(result.output).toContain(`has the title "${title}"`);
    }

    expect(result.output).not.toContain('has the title "reads rows"');
    expect(result.output).not.toContain('has the title "a counted case"');
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
