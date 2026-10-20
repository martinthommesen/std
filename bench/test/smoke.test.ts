import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { parseOptions } from "../src/cli.ts";
import type { BenchmarkOutput } from "../src/pipeline.ts";
import { runBenchmark } from "../src/pipeline.ts";
import { modelIds } from "../src/storage-model.ts";
import { reads } from "../src/workload.ts";

const smokeTimeout = 600_000;
const writesPerRun = 6;

const checkOutput = ({ files, report }: BenchmarkOutput): void => {
  assert.deepStrictEqual(
    report.runs.map((run) => run.model),
    [...modelIds]
  );
  assert.isTrue((report.equivalence?.length ?? 0) >= reads.length);
  assert.isTrue(files.length === 2 && files.every((file) => existsSync(file)));

  for (const run of report.runs) {
    assert.strictEqual(run.reads.length, reads.length);
    assert.strictEqual(run.writes.length, writesPerRun);
    assert.isTrue(run.sizes.length > 0);

    for (const read of run.reads) {
      assert.isTrue(Number.isFinite(read.p95) && read.p95 >= read.p50);
      assert.isTrue(
        read.plans.length > 0 &&
          read.plans.every((plan) => plan.plan.includes("Execution Time"))
      );
    }

    for (const write of run.writes) {
      assert.strictEqual(write.errors, 0, write.errorSamples.join("\n"));
      assert.isTrue(write.operations > 0);
    }
  }
};

describe("bench-smoke", () => {
  it(
    "runs the smoke benchmark end to end in a fresh database",
    async () => {
      const out = mkdtempSync(path.join(tmpdir(), "std-bench-smoke-"));
      const database = `bench_smoke_${process.pid}_${Date.now()}`;

      const options = parseOptions([
        "--smoke",
        "--database",
        database,
        "--out",
        out,
      ]);

      try {
        const output = await Effect.runPromise(
          runBenchmark(options, "vitest bench-smoke")
        );

        checkOutput(output);
        assert.strictEqual(output.report.runs.length, modelIds.length);
      } finally {
        rmSync(out, { force: true, recursive: true });
      }
    },
    smokeTimeout
  );
});
