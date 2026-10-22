import { describe, expect, it } from "vitest";

import type { ProbeResult, ProbeRun } from "../lib/oda-probe-summary.ts";
import { median, nearestRank, summarize } from "../lib/oda-probe-summary.ts";

const gigabyte = 1e9;

const result = (
  canvasSeconds: number,
  failedPhase: string | null = null
): ProbeResult => ({
  disk: {
    before: { availableBytes: 20 * gigabyte, usedBytes: 50 * gigabyte },
    kindNode: { nodeImageBytes: gigabyte, nodeWritableBytes: 6 * gigabyte },
    peakUsedBytes: 58 * gigabyte,
  },
  failedPhase,
  failureExcerpt: failedPhase === null ? null : "line 1\nError: timed out",
  gateway: failedPhase === null ? { ok: true } : null,
  outcome: failedPhase === null ? "success" : "failure",
  phases: [
    { durationSeconds: 30, name: "cluster", status: "success" },
    { durationSeconds: 15, name: "istio", status: "success" },
    failedPhase === "canvas"
      ? { durationSeconds: canvasSeconds, name: "canvas", status: "failure" }
      : { durationSeconds: canvasSeconds, name: "canvas", status: "success" },
    failedPhase === "canvas"
      ? { name: "component", status: "skipped" }
      : { durationSeconds: 10, name: "component", status: "success" },
  ],
  runner: {
    imageOS: "ubuntu24",
    imageVersion: "20261012.1",
    os: "Ubuntu 24.04.3 LTS",
  },
  schemaVersion: 1,
  startedAt: "2026-10-22T10:00:00Z",
});

describe("oda-probe-summary", () => {
  it("computes the median and the nearest-rank p90", () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

    expect(median(values)).toBe(5.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(nearestRank(values, 0.9)).toBe(9);
    expect(nearestRank([4], 0.9)).toBe(4);
  });

  const runs: ProbeRun[] = [
    { conclusion: "success", id: "1", result: result(100) },
    { conclusion: "success", id: "2", result: result(200) },
    { conclusion: "failure", id: "3", result: result(1800, "canvas") },
    { conclusion: "cancelled", id: "4" },
  ];

  it("counts failed runs and runs without a result as failures, by phase", () => {
    const text = summarize(runs);

    expect(text).toContain(
      "- Runs: 4; succeeded 2, failed 2 (failure rate 50%)."
    );
    expect(text).toContain(
      "- Failing phases: canvas 1, no result (run cancelled or timed out) 1."
    );
    expect(text).toContain("Error: timed out");
    expect(text).toContain("| `4` |  | no result (cancelled) |  |");
  });

  it("measures each phase only where it succeeded, and the disk", () => {
    const text = summarize(runs);

    expect(text).toContain("| canvas | 2 | 150 s | 200 s | 200 s | 1 |");
    expect(text).toContain(
      "| bring-up (cluster + istio + canvas + component), successful runs | 2 | 205 s | 255 s | 255 s | |"
    );
    expect(text).toContain(
      "| peak use above the start (root file system) | 3 | 8.0 GB | 8.0 GB | 8.0 GB |"
    );
  });
});
