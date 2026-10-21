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

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "std-bench-smoke-"))),
  (directory) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
);

describe("bench-smoke", () => {
  it("runs every model at 50k records with short measurements", () => {
    const options = parseOptions(["--smoke"]);

    assert.strictEqual(options.mode, "smoke");
    assert.deepStrictEqual(options.models, [...modelIds]);
    assert.deepStrictEqual(
      options.scales.map((scale) => [scale.records, scale.users]),
      [[50_000, 2500]]
    );
    assert.isTrue(options.runs < 200 && options.writeSeconds < 60);
  });

  // it.live: the benchmark measures real time against a real Postgres.
  it.live(
    "runs the smoke benchmark end to end in a fresh database",
    () =>
      Effect.gen(function* smokeTest() {
        const out = yield* temporaryDirectory;
        const database = `bench_smoke_${process.pid}_${Date.now()}`;

        const options = parseOptions([
          "--smoke",
          "--database",
          database,
          "--out",
          out,
        ]);

        const output = yield* runBenchmark(options, "vitest bench-smoke");

        checkOutput(output);
        assert.strictEqual(output.report.runs.length, modelIds.length);
      }),
    smokeTimeout
  );
});
