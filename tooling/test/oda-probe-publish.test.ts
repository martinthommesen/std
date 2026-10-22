import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Result } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { decodeProbeResult } from "../lib/oda-probe-summary.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

// The probe publishes its result even after a full budget of disk samples
// (docs/decisions/0027-oda-canvas-probe.md): 85 minutes at one sample every
// 2 s is 2,550 samples, whose JSON alone is larger than the 128 KiB Linux
// allows for one command-line argument. This uses more than twice that.
const sampleCount = 6000;
const start = 1_790_000_000;

describe("oda-probe-publish", () => {
  const out = mkdtempSync(path.join(tmpdir(), "std-oda-probe-publish-"));

  afterAll(() => {
    rmSync(out, { force: true, recursive: true });
  });

  it("publishes a complete result from a full budget of disk samples", async () => {
    mkdirSync(path.join(out, "state"), { recursive: true });
    mkdirSync(path.join(out, "logs"), { recursive: true });

    const samples = Array.from(
      { length: sampleCount },
      (_, index) =>
        `${start + 2 * index} ${50_000_000_000 + index * 1_000_000} ${20_000_000_000 - index * 1_000_000}`
    );

    writeFileSync(
      path.join(out, "state", "disk-samples"),
      `${samples.join("\n")}\n`
    );
    writeFileSync(
      path.join(out, "state", "phases.jsonl"),
      `${JSON.stringify({
        durationSeconds: 5100,
        endEpoch: start + 2 * sampleCount,
        name: "canvas",
        startEpoch: start,
        status: "success",
      })}\n`
    );

    const run = await runCommand(
      "bash",
      [
        path.join(repoRoot, "deploy", "oda", "probe", "probe.sh"),
        "--publish-test",
      ],
      {
        cwd: out,
        env: {
          ...process.env,
          PROBE_OUT_DIR: out,
          PROBE_TOOLS_DIR: path.join(out, "tools"),
        },
      }
    );

    expect(run.code).toBe(0);

    const text = readFileSync(path.join(out, "result.json"), "utf-8");
    const decoded = decodeProbeResult(text);

    expect(Result.isSuccess(decoded)).toBeTruthy();
    // The result counts every sample (the peak also sees this machine's
    // real disk, sampled before and after).
    expect(text).toContain(`"sampleCount": ${sampleCount}`);
    expect(
      Result.getOrUndefined(decoded)?.disk.peakUsedBytes
    ).toBeGreaterThanOrEqual(50_000_000_000 + (sampleCount - 1) * 1_000_000);
    expect(
      readFileSync(path.join(out, "state", "result-parts", "samples.json"))
        .length
    ).toBeGreaterThan(128 * 1024);
  });
});
