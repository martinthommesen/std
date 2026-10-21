/**
 * Sizes and durations of each probe for a full measurement (`pnpm probes`)
 * and for a quick check of the script itself (`pnpm probes --quick`).
 */
import type { AddClassProbeOptions } from "./add-class.ts";
import type { AddColumnProbeOptions } from "./add-column.ts";
import type { CasefoldProbeOptions } from "./casefold.ts";
import type { ConfigPauseOptions } from "./config-pause.ts";
import type { KilledBuildScenario } from "./killed-index-build.ts";
import type { LockBudgetOptions } from "./lock-budget.ts";
import type { NotifyProbeOptions } from "./notify-throughput.ts";
import type { UnbudgetedOptions } from "./unbudgeted-waits.ts";

/** Measurement mode. */
export type Mode = "full" | "quick";

/** Settings of every probe. */
export interface ProbeSettings {
  readonly configPause: ConfigPauseOptions;
  readonly killedBuild: readonly KilledBuildScenario[];
  readonly addClass: readonly AddClassProbeOptions[];
  readonly lockBudget: readonly LockBudgetOptions[];
  readonly unbudgetedWaits: readonly UnbudgetedOptions[];
  readonly casefold: CasefoldProbeOptions;
  readonly addColumn: AddColumnProbeOptions;
  readonly notify: NotifyProbeOptions;
}

/** Pool size of probe 1: clients plus coordinator, blockers and monitor. */
export const CONFIG_PAUSE_EXTRA_CONNECTIONS = 6;

/** Pool size of probe 6: clients plus the listener and the wake-up. */
export const NOTIFY_EXTRA_CONNECTIONS = 2;

/**
 * The longest request STD allows is just under its 30 s
 * `statement_timeout`, so the "30 s request" sleeps 29.5 s.
 */
const LONG_REQUEST_MS = 29_500;

const killedBuildScenarios = (
  writerRows: number,
  scanRows: number
): readonly KilledBuildScenario[] => [
  {
    busy: "writer",
    checkInterval: "0",
    duplicate: false,
    holdAfterKillMs: 3000,
    label: "waiting for a writer, interval 0",
    rows: writerRows,
    unique: false,
  },
  {
    busy: "writer",
    checkInterval: "0",
    duplicate: true,
    holdAfterKillMs: 3000,
    label: "unique, duplicate arrives, interval 0",
    rows: writerRows,
    unique: true,
  },
  {
    busy: "scan",
    checkInterval: "0",
    duplicate: false,
    holdAfterKillMs: 0,
    label: "scanning a large table, interval 0",
    rows: scanRows,
    unique: false,
  },
  {
    busy: "writer",
    checkInterval: "250ms",
    duplicate: false,
    holdAfterKillMs: 3000,
    label: "waiting for a writer, interval 250ms",
    rows: writerRows,
    unique: false,
  },
  {
    busy: "scan",
    checkInterval: "250ms",
    duplicate: false,
    holdAfterKillMs: 0,
    label: "scanning a large table, interval 250ms",
    rows: scanRows,
    unique: false,
  },
];

/** How long probes 3 and 3b let the commit wait on each blocker: below the 2 s budget. */
export const STAGGERED_HOLD_MS = 1200;

const addClassRuns = (rows: number): readonly AddClassProbeOptions[] => [
  { rows },
  { blocking: { kind: "reader-past-timeout" }, rows },
  {
    blocking: { holdMs: STAGGERED_HOLD_MS, kind: "staggered" },
    mechanism: "per-statement",
    rows,
  },
  {
    blocking: { holdMs: STAGGERED_HOLD_MS, kind: "staggered" },
    mechanism: "lock-budget",
    rows,
  },
];

const LOCK_BUDGET_RUNS: readonly LockBudgetOptions[] = [
  { holdMs: STAGGERED_HOLD_MS, mechanism: "per-statement" },
  { holdMs: STAGGERED_HOLD_MS, mechanism: "lock-budget" },
];

const UNBUDGETED_RUNS: readonly UnbudgetedOptions[] = [
  { holdMs: STAGGERED_HOLD_MS, release: "after-hold", target: "index" },
  { holdMs: STAGGERED_HOLD_MS, release: "after-timeout", target: "index" },
  { holdMs: STAGGERED_HOLD_MS, release: "after-hold", target: "catalog" },
  { holdMs: STAGGERED_HOLD_MS, release: "after-timeout", target: "catalog" },
];

const FULL: ProbeSettings = {
  addClass: addClassRuns(1_000_000),
  addColumn: { rows: 1_000_000 },
  casefold: { rows: 1_000_000 },
  configPause: {
    baselineMs: 10_000,
    batchMs: 2000,
    cancelLongRequest: false,
    clients: 8,
    items: 100_000,
    longRequestMs: LONG_REQUEST_MS,
    streamCommits: 50,
    streamGapMs: 100,
  },
  killedBuild: killedBuildScenarios(100_000, 10_000_000),
  lockBudget: LOCK_BUDGET_RUNS,
  notify: {
    clients: 16,
    durationMs: 60_000,
    records: 100_000,
    rounds: 1,
    warmupMs: 5000,
  },
  unbudgetedWaits: UNBUDGETED_RUNS,
};

const QUICK: ProbeSettings = {
  addClass: addClassRuns(30_000),
  addColumn: { rows: 100_000 },
  casefold: { rows: 50_000 },
  configPause: {
    ...FULL.configPause,
    baselineMs: 2000,
    cancelLongRequest: true,
    items: 10_000,
    streamCommits: 10,
  },
  killedBuild: killedBuildScenarios(10_000, 1_000_000),
  lockBudget: LOCK_BUDGET_RUNS,
  notify: { ...FULL.notify, durationMs: 5000, records: 10_000, warmupMs: 1000 },
  unbudgetedWaits: UNBUDGETED_RUNS,
};

/**
 * The settings of a mode.
 * @param mode - `full` or `quick`.
 * @returns The settings.
 */
export const probeSettings = (mode: Mode): ProbeSettings =>
  mode === "full" ? FULL : QUICK;
