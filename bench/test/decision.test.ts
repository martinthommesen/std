import { assert, describe, it } from "@effect/vitest";

import { decide, fallbackDecision } from "../src/decision.ts";
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
  caller: WriteResult["caller"],
  overrides: Partial<Omit<WriteResult, "caller" | "name">> = {}
): WriteResult => ({
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
  caller,
  name,
});

const decisiveReads = reads
  .filter((def) => def.decisive)
  .map((def) => readResult(def.name, 1));

const run = (
  label: string,
  writes: readonly WriteResult[],
  measuredReads: readonly ReadResult[] = decisiveReads
): ModelRun => ({
  database: label,
  generation: { steps: [], totalSeconds: 0 },
  label,
  load: [],
  mitigations: false,
  model: "class-table",
  reads: measuredReads,
  scale: { label: "10m", records: 10_000_000, users: 50_000 },
  seconds: 0,
  sizes: [],
  startedAt: "",
  writes,
});

const writeNames = ["W1", "W2", "W3"] as const;

const healthyWrites = writeNames.flatMap((name) => [
  writeResult(name, "admin"),
  writeResult(name, "restricted"),
]);

const hasProblem = (problems: readonly string[], text: string): boolean =>
  problems.some((problem) => problem.includes(text));

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
    const failing = healthyWrites.map((write) =>
      write.name === "W1" && write.caller === "admin"
        ? writeResult("W1", "admin", {
            errors: 10_000,
            operations: 1,
            p50: 0.1,
            p95: 0.1,
          })
        : write
    );

    const step = decide(
      run("class-table", failing),
      run("baseline", healthyWrites),
      seconds
    );

    assert.isFalse(step.keep);
    assert.isTrue(hasProblem(step.problems, "10000 errors"));
  });

  it("refuses to judge a write phase that stopped before its full duration", () => {
    const short = healthyWrites.map((write) =>
      write.name === "W3" && write.caller === "restricted"
        ? writeResult("W3", "restricted", { exhausted: true, seconds: 42 })
        : write
    );

    const step = decide(
      run("class-table", healthyWrites),
      run("baseline", short),
      seconds
    );

    assert.isFalse(step.keep);
    assert.isTrue(hasProblem(step.problems, "ran 42 s of 60 s"));
  });

  it("refuses to judge a run with an omitted read or write phase", () => {
    const withoutQ7 = decisiveReads.filter((read) => read.name !== "Q7");

    const withoutW2Restricted = healthyWrites.filter(
      (write) => !(write.name === "W2" && write.caller === "restricted")
    );

    const step = decide(
      run("class-table", withoutW2Restricted, withoutQ7),
      run("baseline", healthyWrites),
      seconds
    );

    assert.isFalse(step.keep);
    assert.isTrue(
      hasProblem(step.problems, "class-table: Q7 (restricted) was not measured")
    );
    assert.isTrue(
      hasProblem(step.problems, "class-table: W2 restricted was not measured")
    );
  });

  it("refuses to judge runs with empty reads or no writes (--no-writes)", () => {
    const onlyQ1 = decisiveReads.filter((read) => read.name === "Q1");

    const step = decide(
      run("class-table", [], onlyQ1),
      run("baseline", healthyWrites, []),
      seconds
    );

    assert.isFalse(step.keep);
    // Seven decisive reads missing from class-table, eight from the baseline, six write phases.
    assert.strictEqual(step.problems.length, 7 + 8 + 6);
    assert.isTrue(
      hasProblem(step.problems, "class-table: Q5.L4 (admin) was not measured")
    );
    assert.isTrue(
      hasProblem(step.problems, "baseline: Q1 (admin) was not measured")
    );
    assert.isTrue(
      hasProblem(step.problems, "class-table: W1 admin was not measured")
    );
  });

  it("does not count a supplementary variant as the decisive read", () => {
    const restrictedOnly = [
      ...decisiveReads.filter((read) => read.name !== "Q2"),
      readResult("Q2 restricted", 1),
    ];

    const step = decide(
      run("class-table", healthyWrites, restrictedOnly),
      run("baseline", healthyWrites),
      seconds
    );

    assert.isTrue(
      hasProblem(step.problems, "class-table: Q2 (admin) was not measured")
    );
  });

  it("reopens after the fallback runs only when they are complete", () => {
    const failed = decide(
      run(
        "class-table",
        healthyWrites,
        decisiveReads.map((read) => ({ ...read, p95: 500 }))
      ),
      run("baseline", healthyWrites),
      seconds
    );

    assert.deepStrictEqual(failed.problems, []);
    assert.isFalse(failed.keep);

    const complete = fallbackDecision(
      [failed, failed],
      [run("partitioned", healthyWrites), run("concrete-table", healthyWrites)],
      seconds
    );

    assert.strictEqual(complete.outcome, "reopen");
    assert.deepStrictEqual(complete.problems, []);

    const erroring = healthyWrites.map((write) =>
      write.name === "W3" && write.caller === "admin"
        ? writeResult("W3", "admin", { errors: 12 })
        : write
    );

    const broken = fallbackDecision(
      [failed, failed],
      [run("partitioned", erroring), run("concrete-table", healthyWrites, [])],
      seconds
    );

    assert.strictEqual(broken.outcome, "invalid-measurement");
    assert.isTrue(
      hasProblem(broken.problems, "partitioned: W3 admin had 12 errors")
    );
    assert.isTrue(
      hasProblem(
        broken.problems,
        "concrete-table: Q6 (restricted) was not measured"
      )
    );
    assert.isTrue(broken.summary.includes("Other runs cannot be judged"));
  });
});
