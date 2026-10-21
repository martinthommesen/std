/**
 * The shape of benchmark results, as written to the JSON file.
 */
import type { HostInfo, LoadWindow, PostgresInfo } from "./environment.ts";
import type { GenerationReport } from "./generate.ts";
import type { ReadResult } from "./measure.ts";
import type { TableSize } from "./sizes.ts";
import type { ModelId } from "./storage-model.ts";
import type { WriteResult } from "./writes.ts";

/** A record-count scale such as `1m`. */
export interface Scale {
  readonly label: string;
  readonly records: number;
  readonly users: number;
}

/** Everything measured for one model at one scale. */
export interface ModelRun {
  readonly label: string;
  readonly model: ModelId;
  readonly scale: Scale;
  readonly mitigations: boolean;
  readonly database: string;
  readonly generation: GenerationReport;
  readonly reads: readonly ReadResult[];
  readonly writes: readonly WriteResult[];
  readonly sizes: readonly TableSize[];
  readonly load: readonly LoadWindow[];
  readonly startedAt: string;
  readonly seconds: number;
}

/** A budget check of one measured request. */
export interface BudgetCheck {
  readonly name: string;
  readonly p95: number;
  readonly budget: number;
  readonly pass: boolean;
}

/** The 2x comparison of one read query. */
export interface Comparison {
  readonly query: string;
  readonly classTableP95: number;
  readonly baselineP95: number;
  /** Class-table p95 divided by baseline p95; above 2 means the baseline is more than 2x faster. */
  readonly ratio: number;
  readonly baselineMoreThan2xFaster: boolean;
}

/** One application of the decision rule. */
export interface DecisionStep {
  readonly classTable: string;
  readonly baseline: string;
  readonly budgets: readonly BudgetCheck[];
  readonly comparisons: readonly Comparison[];
  readonly meetsBudgets: boolean;
  readonly baselineFasterCount: number;
  readonly keep: boolean;
  /**
   * Why a run cannot be judged: missing or empty read measurements, write
   * errors, or a write phase that did not run its full duration. Any problem
   * makes the step invalid; the rule is not applied to it.
   */
  readonly problems: readonly string[];
  /** Budget misses of the supplementary (non-decisive) requests, reported but not decisive. */
  readonly supplementaryMisses: readonly BudgetCheck[];
}

/** The outcomes of the decision rule of Contracts 2.6. */
export const outcomes = [
  "keep-class-table",
  "keep-class-table-with-mitigations",
  "reopen",
  "invalid-measurement",
] as const;

/** One outcome of the decision rule. */
export type Outcome = (typeof outcomes)[number];

/** The outcome of the decision rule of Contracts 2.6. */
export interface Decision {
  readonly outcome: Outcome;
  readonly steps: readonly DecisionStep[];
  readonly summary: string;
}

/** The full results file. */
export interface BenchReport {
  readonly title: string;
  readonly date: string;
  readonly command: string;
  readonly commit: string;
  readonly seed: number;
  readonly method: {
    readonly warmup: number;
    readonly runs: number;
    readonly writeClients: number;
    readonly writeSeconds: number;
  };
  readonly host: HostInfo;
  readonly postgres: PostgresInfo;
  readonly runs: readonly ModelRun[];
  readonly decision: Decision | null;
  readonly equivalence: readonly string[] | null;
  readonly totalSeconds: number;
}
