/**
 * The decision rule of Contracts 2.6: keep class-table storage if it meets
 * every budget at 10M and one table per hierarchy is not more than 2x faster
 * at p95 on more than one read query.
 *
 * Decisive requests are the ones the contract defines: Q1 to Q5 as the admin
 * (Q5 through both endpoints), Q6 and Q7 as the restricted caller, and W1 to
 * W3 as the admin. For the 2x rule a query's p95 is the worst p95 of its
 * decisive variants. The restricted variants of the other requests are
 * reported, and their budget misses listed, but they do not decide.
 */
import type { Caller } from "./access.ts";
import type {
  BudgetCheck,
  Comparison,
  Decision,
  DecisionStep,
  ModelRun,
  Outcome,
} from "./results.ts";
import { round3 } from "./stats.ts";
import type { QueryId } from "./workload.ts";
import { budgets, queryIds, reads, writeBudgetMs } from "./workload.ts";
import type { WriteResult } from "./writes.ts";

const fasterFactor = 2;

const readChecks = (
  run: ModelRun,
  decisive: boolean
): readonly BudgetCheck[] => {
  const checks: BudgetCheck[] = [];

  for (const read of run.reads) {
    if (read.decisive === decisive) {
      const budget = budgets[read.query];

      checks.push({
        budget,
        name: read.name,
        p95: read.p95,
        pass: read.p95 <= budget,
      });
    }
  }

  return checks;
};

const writeChecks = (
  run: ModelRun,
  decisive: boolean
): readonly BudgetCheck[] => {
  const checks: BudgetCheck[] = [];

  for (const write of run.writes) {
    if ((write.caller === "admin") === decisive) {
      const pass = write.p95 <= writeBudgetMs && write.operations > 0;

      checks.push({
        budget: writeBudgetMs,
        name: `${write.name} ${write.caller}`,
        p95: write.p95,
        pass,
      });
    }
  }

  return checks;
};

const worstP95 = (run: ModelRun, query: QueryId): number | null => {
  let worst: number | null = null;

  for (const read of run.reads) {
    if (read.decisive && read.query === query) {
      worst = Math.max(worst ?? read.p95, read.p95);
    }
  }

  return worst;
};

const compare = (
  classTable: ModelRun,
  baseline: ModelRun,
  query: QueryId
): Comparison | null => {
  const ours = worstP95(classTable, query);
  const theirs = worstP95(baseline, query);

  if (ours === null || theirs === null) {
    return null;
  }

  const ratio = theirs > 0 ? ours / theirs : Number.POSITIVE_INFINITY;

  return {
    baselineMoreThan2xFaster: ratio > fasterFactor,
    baselineP95: theirs,
    classTableP95: ours,
    query,
    ratio: round3(ratio),
  };
};

const minimumWriteShare = 0.99;

// The inventory every run the rule uses must have: each decisive read with its
// caller, and W1 to W3 for both callers.
const requiredReads = reads.filter((def) => def.decisive);

const requiredWrites = [
  "W1",
  "W2",
  "W3",
] as const satisfies readonly WriteResult["name"][];

const writeCallers = [
  "admin",
  "restricted",
] as const satisfies readonly Caller["kind"][];

const readProblems = (run: ModelRun): readonly string[] => {
  const problems: string[] = [];

  for (const def of requiredReads) {
    const measured = run.reads.find(
      (read) =>
        read.decisive && read.name === def.name && read.caller === def.caller
    );

    if (measured === undefined) {
      problems.push(
        `${run.label}: ${def.name} (${def.caller}) was not measured`
      );
    } else if (measured.runs === 0 || !Number.isFinite(measured.p95)) {
      problems.push(
        `${run.label}: ${def.name} (${def.caller}) has no measurements`
      );
    }
  }

  return problems;
};

const phaseProblems = (
  run: ModelRun,
  write: WriteResult,
  expectedWriteSeconds: number
): readonly string[] => {
  const label = `${run.label}: ${write.name} ${write.caller}`;
  const problems: string[] = [];

  if (write.errors > 0) {
    problems.push(`${label} had ${write.errors} errors`);
  }

  if (write.operations === 0) {
    problems.push(`${label} completed no operations`);
  }

  if (
    write.exhausted ||
    write.seconds < expectedWriteSeconds * minimumWriteShare
  ) {
    problems.push(
      `${label} ran ${write.seconds} s of ${expectedWriteSeconds} s`
    );
  }

  return problems;
};

const writeProblems = (
  run: ModelRun,
  expectedWriteSeconds: number
): readonly string[] =>
  requiredWrites.flatMap((name) =>
    writeCallers.flatMap((caller) => {
      const phase = run.writes.find(
        (write) => write.name === name && write.caller === caller
      );

      return phase === undefined
        ? [`${run.label}: ${name} ${caller} was not measured`]
        : phaseProblems(run, phase, expectedWriteSeconds);
    })
  );

/**
 * Why a run is unfit for the decision rule. The run must contain every
 * decisive read (Q1 to Q7, Q5 through both endpoints, each with its caller)
 * with measurements, and W1 to W3 for both callers, each error-free, with
 * operations, and run for its full duration. Missing entries are problems,
 * so a partial run (for example `--no-writes`) is never judged.
 *
 * @param run - One model run.
 * @param expectedWriteSeconds - How long each write phase should have run.
 * @returns One message per problem; empty when the run is complete.
 */
export const measurementProblems = (
  run: ModelRun,
  expectedWriteSeconds: number
): readonly string[] => [
  ...readProblems(run),
  ...writeProblems(run, expectedWriteSeconds),
];

/**
 * Applies the rule to one class-table run and one baseline run.
 *
 * @param classTable - The class-table run at 10M.
 * @param baseline - The one-table-per-hierarchy run at 10M.
 * @param expectedWriteSeconds - How long each write phase should have run.
 * @returns The budget checks, comparisons and verdict.
 */
export const decide = (
  classTable: ModelRun,
  baseline: ModelRun,
  expectedWriteSeconds: number
): DecisionStep => {
  const problems = [
    ...measurementProblems(classTable, expectedWriteSeconds),
    ...measurementProblems(baseline, expectedWriteSeconds),
  ];

  const checks = [
    ...readChecks(classTable, true),
    ...writeChecks(classTable, true),
  ];

  const comparisons: Comparison[] = [];

  for (const query of queryIds) {
    const comparison = compare(classTable, baseline, query);

    if (comparison !== null) {
      comparisons.push(comparison);
    }
  }

  const meetsBudgets = checks.every((check) => check.pass);

  const baselineFasterCount = comparisons.filter(
    (comparison) => comparison.baselineMoreThan2xFaster
  ).length;

  const supplementary = [
    ...readChecks(classTable, false),
    ...writeChecks(classTable, false),
  ];

  return {
    baseline: baseline.label,
    baselineFasterCount,
    budgets: checks,
    classTable: classTable.label,
    comparisons,
    keep: problems.length === 0 && meetsBudgets && baselineFasterCount <= 1,
    meetsBudgets,
    problems,
    supplementaryMisses: supplementary.filter((check) => !check.pass),
  };
};

const missText = (step: DecisionStep): string => {
  const misses: string[] = [];

  for (const check of step.budgets) {
    if (!check.pass) {
      misses.push(`${check.name} (${check.p95} ms > ${check.budget} ms)`);
    }
  }

  return misses.length === 0
    ? "meets every budget"
    : `misses ${misses.join(", ")}`;
};

const fasterText = (step: DecisionStep): string => {
  const faster: string[] = [];

  for (const comparison of step.comparisons) {
    if (comparison.baselineMoreThan2xFaster) {
      faster.push(`${comparison.query} (${comparison.ratio}x)`);
    }
  }

  if (faster.length === 0) {
    return "the baseline is not more than 2x faster on any read query";
  }

  const noun = faster.length === 1 ? "query" : "queries";

  return `the baseline is more than 2x faster on ${faster.length} read ${noun}: ${faster.join(", ")}`;
};

/**
 * One sentence explaining a decision step.
 *
 * @param step - The step.
 * @returns The explanation.
 */
export const explainStep = (step: DecisionStep): string => {
  if (step.problems.length > 0) {
    return `${step.classTable} against ${step.baseline} cannot be judged: ${step.problems.join("; ")}.`;
  }

  const verdict = step.keep ? "keep" : "not met";

  return `${step.classTable} ${missText(step)}; ${fasterText(step)} (vs ${step.baseline}). Rule: ${verdict}.`;
};

const verdicts: Readonly<Record<Outcome, string>> = {
  "invalid-measurement":
    "The runs cannot be judged: the decision rule needs complete, error-free measurements, so it was not applied. Fix the problems below and rerun.",
  "keep-class-table": "Class-table storage is kept.",
  "keep-class-table-with-mitigations":
    "Class-table storage is kept, with the class_id-led mitigation indexes.",
  reopen:
    "Class-table storage does not satisfy the decision rule, with or without the class_id index mitigations. " +
    "The other two models were benchmarked and the storage decision is reopened: Stage 0 stops here for Martin's decision.",
};

/**
 * Builds the decision from an outcome, the rule's steps and any problems in
 * runs outside those steps.
 *
 * @param outcome - The outcome.
 * @param steps - The decision steps applied.
 * @param problems - Problems of runs the steps do not cover (the fallback runs).
 * @returns The decision with its summary.
 */
export const summarize = (
  outcome: Outcome,
  steps: readonly DecisionStep[],
  problems: readonly string[] = []
): Decision => {
  const unfit =
    problems.length === 0
      ? []
      : [`Other runs cannot be judged: ${problems.join("; ")}.`];

  return {
    outcome,
    problems,
    steps,
    summary: [
      verdicts[outcome],
      ...steps.map((step) => explainStep(step)),
      ...unfit,
    ].join(" "),
  };
};

/**
 * The outcome after the rule failed with and without mitigations and the
 * other two models were benchmarked: reopen, unless a fallback run is
 * incomplete or had write failures, which makes the measurement invalid.
 *
 * @param steps - The two failed decision steps.
 * @param fallbackRuns - The partitioned and per-concrete-class runs.
 * @param expectedWriteSeconds - How long each write phase should have run.
 * @returns The decision.
 */
export const fallbackDecision = (
  steps: readonly DecisionStep[],
  fallbackRuns: readonly ModelRun[],
  expectedWriteSeconds: number
): Decision => {
  const problems = fallbackRuns.flatMap((run) =>
    measurementProblems(run, expectedWriteSeconds)
  );

  return summarize(
    problems.length === 0 ? "reopen" : "invalid-measurement",
    steps,
    problems
  );
};
