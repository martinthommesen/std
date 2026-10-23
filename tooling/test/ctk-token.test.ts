import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

// The CTK runner's bearer token never reaches a command line or a log
// line (decision 0035): `pnpm ctk` takes it from a file only its owner may
// read, and pnpm's echo of the command it runs shows the file's path. The
// runs below stop before any download or Docker call (an unknown kit, a
// shared file, the removed `--token` flag), with a sentinel token.

const SENTINEL = "sentinel-token-7f3c9e1a";
const directory = mkdtempSync(path.join(tmpdir(), "std-ctk-token-"));
const tokenFile = path.join(directory, "token");

writeFileSync(tokenFile, SENTINEL, { mode: 0o600 });

const ctk = async (args: readonly string[]) =>
  await runCommand("pnpm", ["ctk", ...args], { cwd: repoRoot });

describe("ctk-token", () => {
  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("reads the token from its file and never prints it", async () => {
    const result = await ctk([
      "tmf000",
      "--url",
      "http://127.0.0.1:9/tmf-api/x/v5",
      "--token-file",
      tokenFile,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("--token-file");
    expect(result.output).toContain("tmf000 has no pinned kit");
    expect(result.output).not.toContain(SENTINEL);
  });

  it("refuses a token file others may read, without printing the token", async () => {
    const shared = path.join(directory, "shared");

    writeFileSync(shared, SENTINEL);
    chmodSync(shared, 0o644);

    const result = await ctk([
      "tmf621",
      "--url",
      "http://127.0.0.1:9/tmf-api/troubleTicket/v5",
      "--token-file",
      shared,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("make it mode 0600");
    expect(result.output).not.toContain(SENTINEL);
  });

  it("takes no token argument", async () => {
    const result = await ctk([
      "tmf621",
      "--url",
      "http://127.0.0.1:9/tmf-api/troubleTicket/v5",
      "--token",
      SENTINEL,
    ]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("--token");
  });
});
