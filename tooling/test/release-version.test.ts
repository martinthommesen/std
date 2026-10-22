import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/release.yml"),
  "utf-8"
);

const gate =
  / {6}- name: Release gate[\s\S]*? {8}run: \|\n(?<script>(?: {10}.*\n)+)/u.exec(
    workflow
  )?.groups?.script;

if (gate === undefined) {
  throw new Error("Release workflow has no executable gate");
}

const script = gate.replaceAll(/^ {10}/gmu, "");

describe("release-version", () => {
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

        const result = await runCommand("/bin/bash", ["-c", script], {
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
