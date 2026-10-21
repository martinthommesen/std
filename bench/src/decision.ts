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
import type {
  BudgetCheck,
  Comparison,
  DecisionStep,
  ModelRun,
} from "./results.ts";
import { round3 } from "./stats.ts";
import type { QueryId } from "./workload.ts";
import { budgets, queryIds, writeBudgetMs } from "./workload.ts";

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

// Problems that make a run unfit for the rule: every decisive read measured,
// every write phase error-free and run for its full duration.
const problemsOf = (
  run: ModelRun,
  expectedWriteSeconds: number
): readonly string[] => {
  const problems: string[] = [];

  for (const read of run.reads) {
    if (read.decisive && (read.runs === 0 || !Number.isFinite(read.p95))) {
      problems.push(`${run.label}: ${read.name} has no measurements`);
    }
  }

  if (run.reads.filter((read) => read.decisive).length === 0) {
    problems.push(`${run.label}: no decisive reads`);
  }

  for (const write of run.writes) {
    const label = `${run.label}: ${write.name} ${write.caller}`;

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
  }

  return problems;
};

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
    ...problemsOf(classTable, expectedWriteSeconds),
    ...problemsOf(baseline, expectedWriteSeconds),
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
