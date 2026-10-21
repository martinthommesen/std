import { assert, describe, it } from "@effect/vitest";

import { decide } from "../src/decision.ts";
import type { ReadResult } from "../src/measure.ts";
import type { ModelRun } from "../src/results.ts";
import { reads } from "../src/workload.ts";
import type { WriteResult } from "../src/writes.ts";

const seconds = 60;

const readResult = (name: string, p95: number): ReadResult => {
  const def = reads.find((entry) => entry.name === name);

  if (def === undefined) {
    throw new Error(`unknown read ${name}`);
  }

  return {
    caller: def.caller,
    decisive: def.decisive,
    description: def.description,
    endpoint: def.endpoint,
    max: p95,
    meanRows: 50,
    medianRun: 0,
    min: p95,
    name,
    p50: p95,
    p95,
    plans: [],
    query: def.query,
    runs: 200,
  };
};

const writeResult = (
  name: WriteResult["name"],
  overrides: Partial<Omit<WriteResult, "name">> = {}
): WriteResult => ({
  caller: "admin",
  clients: 16,
  description: name,
  errorSamples: [],
  errors: 0,
  exhausted: false,
  operations: 300_000,
  p50: 2,
  p95: 5,
  refused: 0,
  seconds,
  throughput: 5000,
  ...overrides,
  name,
});

const run = (label: string, writes: readonly WriteResult[]): ModelRun => ({
  database: label,
  generation: { steps: [], totalSeconds: 0 },
  label,
  load: [],
  mitigations: false,
  model: "class-table",
  reads: reads
    .filter((def) => def.decisive)
    .map((def) => readResult(def.name, 1)),
  scale: { label: "10m", records: 10_000_000, users: 50_000 },
  seconds: 0,
  sizes: [],
  startedAt: "",
  writes,
});

const healthyWrites = [writeResult("W1"), writeResult("W2"), writeResult("W3")];

describe("decision", () => {
  it("keeps class-table when complete measurements meet every budget", () => {
    const step = decide(
      run("class-table", healthyWrites),
      run("baseline", healthyWrites),
      seconds
    );

    assert.deepStrictEqual(step.problems, []);
    assert.isTrue(step.keep);
  });

  it("refuses to judge a run whose writes failed, however fast the successes", () => {
    const failing = [
      writeResult("W1", { errors: 10_000, operations: 1, p50: 0.1, p95: 0.1 }),
      writeResult("W2"),
      writeResult("W3"),
    ];

    const step = decide(
      run("class-table", failing),
      run("baseline", healthyWrites),
      seconds
    );

    assert.isFalse(step.keep);
    assert.isTrue(
      step.problems.some((problem) => problem.includes("10000 errors"))
    );
  });

  it("refuses to judge a write phase that stopped before its full duration", () => {
    const short = [
      writeResult("W1"),
      writeResult("W2"),
      writeResult("W3", { exhausted: true, seconds: 42 }),
    ];

    const step = decide(
      run("class-table", healthyWrites),
      run("baseline", short),
      seconds
    );

    assert.isFalse(step.keep);
    assert.isTrue(
      step.problems.some((problem) => problem.includes("ran 42 s of 60 s"))
    );
  });
});
