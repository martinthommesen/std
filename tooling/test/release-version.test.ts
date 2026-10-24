import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/release.yml"),
  "utf-8"
);

const ReleaseWorkflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.optionalKey(Schema.String),
            run: Schema.optionalKey(Schema.String),
          })
        )
      ),
    })
  ),
});

const parsedWorkflow: unknown = parse(workflow);
const { jobs } = Schema.decodeUnknownSync(ReleaseWorkflow)(parsedWorkflow);
const script = path.join(repoRoot, "docker/release-gate.sh");

describe("release-version", () => {
  it("wires the release workflow to the tested gate", () => {
    const gates = Object.values(jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.name === "Release gate");

    expect(gates.map((gate) => gate.run)).toStrictEqual([
      "bash docker/release-gate.sh",
    ]);
  });

  it.each([
    ["0.0.3", "v0.0.3", "tag", 0],
    ["0.0.3", "v0.0.2", "tag", 1],
    ["0.0.3", "v0.0.3-rc.1", "tag", 1],
    ["0.0.3-rc.1", "v0.0.3-rc.1", "tag", 1],
    ["0.0.3+build", "v0.0.3+build", "tag", 1],
    ["00.0.3", "v00.0.3", "tag", 1],
    ["0.0.3", "v0.0.3", "branch", 1],
  ])(
    "version %s and ref %s (%s) exit %i",
    async (version, tag, refType, code) => {
      const scratch = mkdtempSync(path.join(tmpdir(), "std-release-gate-"));

      try {
        mkdirSync(path.join(scratch, "packages/server"), { recursive: true });
        writeFileSync(
          path.join(scratch, "packages/server/package.json"),
          JSON.stringify({ version })
        );

        const result = await runCommand("/bin/bash", [script], {
          cwd: scratch,
          env: {
            ...process.env,
            GITHUB_OUTPUT: path.join(scratch, "output"),
            GITHUB_REF_NAME: tag,
            GITHUB_REF_TYPE: refType,
          },
        });

        expect(result.code).toBe(code);
      } finally {
        rmSync(scratch, { force: true, recursive: true });
      }
    }
  );
});
