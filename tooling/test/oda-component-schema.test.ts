import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { repoRoot } from "../lib/workspace.ts";
import { runTool } from "./run-tools.ts";

// Contracts 13.6, `oda-component-schema`, for the Step 3 probe's stub
// (docs/decisions/0027-oda-canvas-probe.md).
const stub = readFileSync(
  path.join(
    repoRoot,
    "deploy",
    "oda",
    "probe-stub",
    "templates",
    "component.yaml"
  ),
  "utf-8"
);

const scratch = mkdtempSync(path.join(tmpdir(), "std-oda-schema-"));

const variant = (name: string, text: string): string => {
  const file = path.join(scratch, `${name}.yaml`);

  writeFileSync(file, text);

  return file;
};

describe("oda-component-schema", () => {
  afterAll(() => {
    rmSync(scratch, { force: true, recursive: true });
  });

  it("passes the probe's stub component", async () => {
    const result = await runTool("check-oda-component-schema.ts");

    expect(result.code).toBe(0);
  });

  it("fails an unknown field, a value outside an enum and a broken CEL rule", async () => {
    const file = variant(
      "broken",
      stub
        .replace("        port: 8080", "        portNumber: 8080")
        .replace("apiType: openapi", "apiType: graphql")
    );

    const result = await runTool("check-oda-component-schema.ts", [
      "--component",
      file,
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      '.spec.coreFunction.exposedAPIs[0].apiType: "graphql" is not one of ["openapi","mcp"]'
    );
    expect(result.output).toContain(
      ".spec.coreFunction.exposedAPIs[0].portNumber: not in the schema"
    );
    expect(result.output).toContain(
      ".spec.coreFunction.exposedAPIs[0]: apiType, implementation, path, and port must be defined"
    );
  });

  it("fails a missing required field", async () => {
    const file = variant(
      "unnamed",
      stub.replace("      - name: probe\n        id:", "      - id:")
    );

    const result = await runTool("check-oda-component-schema.ts", [
      "--component",
      file,
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain(
      ".spec.coreFunction.exposedAPIs[0]: missing required field name"
    );
  });

  it("fails Helm directives, which would hide the rendered component", async () => {
    const file = variant(
      "templated",
      stub.replace("  name: std-probe\n", '  name: "{{ .Release.Name }}"\n')
    );

    const result = await runTool("check-oda-component-schema.ts", [
      "--component",
      file,
    ]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("has Helm directives");
  });
});
