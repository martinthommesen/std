import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Result } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import type { ProbeAttempt, ProbeResult } from "../lib/oda-probe-summary.ts";
import {
  decodeProbeResult,
  median,
  nearestRank,
  provenanceProblem,
  summarize,
} from "../lib/oda-probe-summary.ts";
import { runCommand } from "../lib/run.ts";
import { repoRoot } from "../lib/workspace.ts";

const gigabyte = 1e9;
const sha = "a".repeat(40);

interface Options {
  readonly attempt?: number;
  readonly canvasSeconds?: number;
  readonly failedPhase?: string | null;
  readonly helm?: string;
  readonly runId?: string;
}

const result = (options: Options = {}): ProbeResult => {
  const failedPhase = options.failedPhase ?? null;
  const canvasSeconds = options.canvasSeconds ?? 100;

  return {
    disk: {
      before: { availableBytes: 20 * gigabyte, usedBytes: 50 * gigabyte },
      kindNode: {
        nodeImageBytes: gigabyte,
        nodeVarBytes: 6 * gigabyte,
        nodeWritableBytes: 0.01 * gigabyte,
      },
      minAvailableBytes: 12 * gigabyte,
      peakUsedBytes: 58 * gigabyte,
      sampleIntervalSeconds: 2,
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
    pins: { canvasOda: "1.2.5", helm: options.helm ?? "v3.18.4" },
    run: {
      githubActions: true,
      probeSha256: "p".repeat(64),
      runAttempt: String(options.attempt ?? 1),
      runId: options.runId ?? "1",
      sha,
      stubChartSha256: "s".repeat(64),
    },
    runner: {
      imageOS: "ubuntu24",
      imageVersion: "20261012.1",
      os: "Ubuntu 24.04.3 LTS",
    },
    schemaVersion: 1,
    stage: "complete",
    startedAt: "2026-10-22T10:00:00Z",
  };
};

const attempt = (runId: string, probe: ProbeResult): ProbeAttempt => ({
  attempt: 1,
  conclusion: probe.outcome,
  headSha: sha,
  result: probe,
  runId,
});

const missing = (runId: string, problem: string): ProbeAttempt => ({
  attempt: 1,
  conclusion: "failure",
  headSha: sha,
  problem,
  runId,
});

describe("oda-probe-summary", () => {
  it("computes the median and the nearest-rank p90", () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

    expect(median(values)).toBe(5.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(nearestRank(values, 0.9)).toBe(9);
    expect(nearestRank([4], 0.9)).toBe(4);
  });

  const attempts: ProbeAttempt[] = [
    attempt("1", result({ canvasSeconds: 100 })),
    attempt("2", result({ canvasSeconds: 200 })),
    attempt("3", result({ canvasSeconds: 1800, failedPhase: "canvas" })),
    missing("4", "no artifact (conclusion cancelled)"),
  ];

  it("counts failed attempts and attempts without a result as failures", () => {
    const text = summarize(attempts);

    expect(text).toContain(
      "- Attempts: 4 in 4 runs; succeeded 2, failed 2 (failure rate 50%)."
    );
    expect(text).toContain("- Failing phases: canvas 1, no usable result 1.");
    expect(text).toContain("Error: timed out");
    expect(text).toContain("no usable result (failure)");
  });

  it("measures each phase only where it succeeded, and the disk", () => {
    const text = summarize(attempts);

    expect(text).toContain("| canvas | 2 | 150 s | 200 s | 200 s | 1 |");
    expect(text).toContain(
      "| bring-up (cluster + istio + canvas + component), successful attempts | 2 | 205 s | 255 s | 255 s | |"
    );
    expect(text).toContain(
      "| peak use above the start (sampled) | 3 | 8.0 GB | 8.0 GB | 8.0 GB |"
    );
    expect(text).toContain(
      "| kind node: /var at the end (images, etcd, logs) | 3 | 6.0 GB | 6.0 GB | 6.0 GB |"
    );
  });

  it("flags a result of another run, attempt or commit", () => {
    const source = {
      attempt: 2,
      conclusion: "failure",
      headSha: sha,
      runId: "7",
    };

    expect(
      provenanceProblem(source, result({ attempt: 2, runId: "7" }))
    ).toBeUndefined();
    expect(provenanceProblem(source, result({ attempt: 1, runId: "7" }))).toBe(
      "provenance mismatch: runAttempt 1 (expected 2)"
    );
  });

  it("reports an unreadable result instead of throwing", () => {
    const decoded = decodeProbeResult('{"schemaVersion":1,');

    expect(Result.isFailure(decoded)).toBeTruthy();
  });

  it("warns when the attempts ran different pins", () => {
    const text = summarize([
      attempt("1", result()),
      attempt("2", result({ helm: "v3.19.0" })),
    ]);

    expect(text).toContain("**Warning: the attempts ran different");
  });
});

// The command itself, against a fake `gh` that serves runs, attempts and
// artifacts from files.
describe("oda-probe-summary command", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "std-oda-probe-gh-"));
  const artifacts = path.join(scratch, "artifacts");

  afterAll(() => {
    rmSync(scratch, { force: true, recursive: true });
  });

  const run = (id: number, attempts: number) => ({
    attempt: attempts,
    conclusion: "failure",
    databaseId: id,
    headSha: sha,
    status: "completed",
    url: `https://example.invalid/runs/${id}`,
    workflowName: "ODA Canvas probe",
  });

  const artifact = (name: string, text: string): void => {
    mkdirSync(path.join(artifacts, name), { recursive: true });
    writeFileSync(path.join(artifacts, name, "result.json"), text);
  };

  writeFileSync(
    path.join(scratch, "runs.json"),
    JSON.stringify([run(100, 2), run(101, 1), run(102, 1), run(103, 1)])
  );
  // Run 100: attempt 1 succeeded, its rerun failed before uploading.
  artifact(
    "oda-canvas-probe-100-1",
    JSON.stringify(result({ attempt: 1, runId: "100" }))
  );
  artifact("oda-canvas-probe-101-1", '{"schemaVersion":1,');
  artifact(
    "oda-canvas-probe-102-1",
    JSON.stringify(result({ attempt: 1, runId: "999" }))
  );
  artifact(
    "oda-canvas-probe-103-1",
    JSON.stringify(result({ attempt: 1, runId: "103" }))
  );

  const fakeGh = path.join(scratch, "gh");

  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "run list") cat "${scratch}/runs.json" ;;
  "api "*)
    attempt=\${2##*/}
    rest=\${2%/attempts/*}
    run=\${rest##*/}
    printf '{"conclusion":"%s","head_sha":"${sha}","html_url":"https://example.invalid/runs/%s","run_attempt":%s}' \\
      "$([[ $run == 100 && $attempt == 2 ]] && echo failure || echo success)" "$run" "$attempt" ;;
  "run download")
    name=$5 dir=$7
    [[ -d "${artifacts}/$name" ]] || exit 1
    mkdir -p "$dir" && cp "${artifacts}/$name/result.json" "$dir/" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`
  );
  chmodSync(fakeGh, 0o755);

  it("counts every attempt, and unreadable or foreign results as failures", async () => {
    const output = await runCommand(
      process.execPath,
      [
        path.join(repoRoot, "tooling", "oda-canvas-probe-summary.ts"),
        "--repo",
        "o/r",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${scratch}:${process.env.PATH ?? ""}` },
      }
    );

    expect(output.code).toBe(0);
    expect(output.output).toContain(
      "- Attempts: 5 in 4 runs; succeeded 2, failed 3 (failure rate 60%)."
    );
    expect(output.output).toContain("no artifact (conclusion failure)");
    expect(output.output).toContain("unreadable result.json");
    expect(output.output).toContain(
      "provenance mismatch: runId 999 (expected 102)"
    );
  });

  it("refuses attempts with different pins unless --allow-mixed", async () => {
    const first = path.join(scratch, "first.json");
    const second = path.join(scratch, "second.json");

    writeFileSync(first, JSON.stringify(result()));
    writeFileSync(second, JSON.stringify(result({ helm: "v3.19.0" })));

    const script = path.join(
      repoRoot,
      "tooling",
      "oda-canvas-probe-summary.ts"
    );

    const args = [script, "--from", first, "--from", second];

    const refused = await runCommand(process.execPath, args, {
      cwd: repoRoot,
    });

    const allowed = await runCommand(
      process.execPath,
      [...args, "--allow-mixed"],
      { cwd: repoRoot }
    );

    expect(refused.code).toBe(1);
    expect(refused.output).toContain("2 different configurations");
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("**Warning");
  });
});
