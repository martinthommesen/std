/**
 * The results file of a measurement run: one JSON document and a Markdown
 * rendering ready to quote in `docs/decisions/0007-platform-probes.md`.
 */
import type { AddClassProbeResult, HeldLock } from "./add-class.ts";
import type { AddColumnProbeResult } from "./add-column.ts";
import type { CasefoldProbeResult } from "./casefold.ts";
import type {
  CommitOutcome,
  ConfigPauseResult,
  WindowStats,
} from "./config-pause.ts";
import type { Conditions, Environment } from "./environment.ts";
import type { KilledBuildResult } from "./killed-index-build.ts";
import type { NotifyProbeResult } from "./notify-throughput.ts";
import type { Mode } from "./settings.ts";
import { round } from "./stats.ts";
import type { Summary } from "./stats.ts";

/** The contract's bound for a boolean or constant-default `ADD COLUMN` (Contracts 6.5). */
export const ADD_COLUMN_BOUND_MS = 100;

/** One probe's result with the conditions it ran under. */
export interface ProbeRecord<T> {
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly before: Conditions;
  readonly after: Conditions;
  readonly result: T;
}

/** Everything one measurement run produced. */
export interface ProbeReport {
  readonly mode: Mode;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly environment: Environment;
  readonly configPause: ProbeRecord<ConfigPauseResult> | null;
  readonly killedBuild: ProbeRecord<readonly KilledBuildResult[]> | null;
  readonly addClass: ProbeRecord<readonly AddClassProbeResult[]> | null;
  readonly casefold: ProbeRecord<CasefoldProbeResult> | null;
  readonly addColumn: ProbeRecord<AddColumnProbeResult> | null;
  readonly notify: ProbeRecord<NotifyProbeResult> | null;
}

const ms = (value: number): string => `${round(value, 1)} ms`;

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const verdict = (holds: boolean): string =>
  holds ? "**Holds.**" : "**Does not hold.**";

const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const loadText = (conditions: Conditions): string =>
  conditions.loadAverage.map((value) => round(value, 2)).join(" / ");

const conditionsLine = (record: ProbeRecord<unknown>): string =>
  `Ran ${record.startedAt}, ${round(record.elapsedMs / 1000, 1)} s. Load average (1/5/15 min) ${loadText(record.before)} before, ${loadText(record.after)} after; other sessions on the server ${record.before.otherSessions} (${record.before.otherActive} active) before, ${record.after.otherSessions} (${record.after.otherActive} active) after; ${record.before.testDatabases} other test databases existed.`;

const summaryCells = (summary: Summary): readonly string[] => [
  ms(summary.p50),
  ms(summary.p95),
  ms(summary.p99),
  ms(summary.max),
];

const commitText = (commit: CommitOutcome): string => {
  const attempts =
    commit.attempts === null
      ? `${commit.attemptsWithLock} attempt(s) got CONFIG_KEY`
      : `${commit.attempts} attempts, ${commit.attemptsWithLock} got CONFIG_KEY`;

  const holders =
    commit.holders.length === 0 ? "" : `; holders ${commit.holders.join(", ")}`;

  return `${commit.outcome} after ${ms(commit.elapsedMs)} (${attempts}${holders})`;
};

const windowRow = (
  label: string,
  window: WindowStats,
  commit: string
): readonly string[] => [
  label,
  String(window.requests),
  String(round(window.requestsPerSecond, 0)),
  ms(window.start.p50),
  ms(window.start.p95),
  ms(window.start.max),
  ...summaryCells(window.total),
  ms(window.longestGapMs),
  `${window.stallCount} (max ${ms(Math.max(0, ...window.stalls.map((stall) => stall.ms)))})`,
  commit,
];

const renderConfigPause = (record: ProbeRecord<ConfigPauseResult>): string => {
  const { result } = record;
  const { options } = result;

  const worstStall = Math.max(
    0,
    ...result.tableLock.window.stalls.map((stall) => stall.ms),
    ...result.batchOnly.window.stalls.map((stall) => stall.ms),
    ...result.longRequest.window.stalls.map((stall) => stall.ms)
  );

  const longPause = Math.max(
    result.longRequest.window.total.max,
    result.longRequest.window.longestGapMs
  );

  return [
    "## Probe 1: begin_request() and request latency during config commits",
    "",
    conditionsLine(record),
    "",
    `${options.clients} closed-loop clients run short request transactions (\`Transactions.request\`: BEGIN, two SET LOCALs, \`core.begin_request()\`, one primary-key read on ${options.items} rows, COMMIT). "Start" is the time until the request's code runs (BEGIN, SET LOCALs and \`begin_request()\`, including any CONFIG_KEY wait); "total" is the whole request. A stall is a run of overlapping requests slower than 50 ms.`,
    "",
    table(
      [
        "Scenario",
        "Requests",
        "Req/s",
        "Start p50",
        "Start p95",
        "Start max",
        "Total p50",
        "Total p95",
        "Total p99",
        "Total max",
        "Longest gap",
        "Stalls",
        "Config commit",
      ],
      [
        windowRow(
          `baseline (${options.baselineMs / 1000} s)`,
          result.baseline,
          "none"
        ),
        windowRow(
          `stream of ${result.stream.commits} config commits`,
          result.stream.window,
          `${round(result.stream.commitsPerSecond, 1)}/s`
        ),
        windowRow(
          "one commit vs 30 s request + 2 s batch",
          result.longRequest.window,
          commitText(result.longRequest.commit)
        ),
        windowRow(
          "one commit vs 2 s batch only",
          result.batchOnly.window,
          commitText(result.batchOnly.commit)
        ),
        windowRow(
          `one commit whose DDL waits for a ${options.tableHoldMs / 1000} s table lock`,
          result.tableLock.window,
          commitText(result.tableLock.commit)
        ),
      ]
    ),
    "",
    `Stream commits (small DDL change set on the coordinator's dedicated connection): whole commit p50 ${ms(result.stream.commitMs.p50)}, p95 ${ms(result.stream.commitMs.p95)}, max ${ms(result.stream.commitMs.max)}; CONFIG_KEY held (the pause each commit causes) p50 ${ms(result.stream.heldMs.p50)}, p95 ${ms(result.stream.heldMs.p95)}, max ${ms(result.stream.heldMs.max)}.`,
    "",
    `Long request: PID ${result.longRequest.longRequestPid}, ${result.longRequest.longRequestOutcome} after ${ms(result.longRequest.longRequestMs)}; still running when the config commit gave up: ${yesNo(result.longRequest.longRequestRunningAtEnd)}. The write batch inserted ${result.longRequest.batchRows} rows.`,
    "",
    `Contract bound per attempt (CONFIG_KEY wait 200 ms + DDL lock wait 2 s + main transaction p95): ${ms(result.boundMs)}. Worst stall in the single-commit scenarios: ${ms(worstStall)}. ${verdict(worstStall <= result.boundMs)}`,
    "",
    `A config commit that has to wait for the 30 s request: longest request or gap while it tried ${ms(longPause)}, and it ended with ${result.longRequest.commit.outcome}. ${verdict(longPause < result.boundMs && result.longRequest.commit.outcome === "SchemaLockTimeout")}`,
  ].join("\n");
};

const releaseText = (exitMs: number | null): string => {
  if (exitMs === null) {
    return "n/a";
  }

  return exitMs < 0 ? "exited before" : ms(exitMs);
};

const renderKilledBuild = (
  record: ProbeRecord<readonly KilledBuildResult[]>
): string =>
  [
    "## Probe 2: killed client of a concurrent index build",
    "",
    conditionsLine(record),
    "",
    'A child process takes `SCHEMA_KEY` with `pg_try_advisory_lock` on a dedicated connection and runs `CREATE [UNIQUE] INDEX CONCURRENTLY`; the probe kills the process with SIGKILL (the backend is not signalled). "After kill" columns are read when the probe stops watching (the hold time for writer scenarios, at once for scans).',
    "",
    table(
      [
        "Scenario",
        "Rows",
        "check interval",
        "Phase at kill",
        "Backend alive after kill",
        "SCHEMA_KEY held",
        "try-lock refused",
        "Backend exit after kill",
        "Exit after writer commit",
        "Index",
        "SCHEMA_KEY free after",
      ],
      record.result.map((result) => [
        result.scenario.label,
        String(result.scenario.rows),
        result.effectiveCheckInterval,
        result.phaseAtKill,
        yesNo(result.backendAliveAfterKill),
        yesNo(result.lockHeldAfterKill),
        yesNo(result.tryLockRefusedAfterKill),
        ms(result.backendExitAfterKillMs),
        releaseText(result.backendExitAfterReleaseMs),
        result.indexState,
        yesNo(result.lockFreeAfterEnd),
      ])
    ),
    "",
    `With interval 0 the backend outlives its client and keeps SCHEMA_KEY until the build ends, then leaves a valid or an invalid index: ${verdict(
      record.result
        .filter((result) => result.effectiveCheckInterval === "0")
        .every(
          (result) =>
            result.backendAliveAfterKill &&
            result.lockHeldAfterKill &&
            result.indexState !== "missing" &&
            result.lockFreeAfterEnd
        )
    )}`,
  ].join("\n");

const readerText = (holdMs: number | null): string =>
  holdMs === null
    ? ""
    : `, a plain session holds the root and laptop tables for ${holdMs / 1000} s`;

const lockText = (lock: HeldLock): string => `${lock.object} ${lock.mode}`;

const renderAddClass = (
  record: ProbeRecord<readonly AddClassProbeResult[]>
): string =>
  [
    "## Probe 3: adding a class to a populated hierarchy",
    "",
    conditionsLine(record),
    "",
    ...record.result.flatMap((result) => [
      `### ${result.rows} records${readerText(result.readerHoldMs)}`,
      "",
      `Config commit: ${result.attempts} attempt(s) got past CONFIG_KEY, ${ms(result.commitMs)} in total.`,
      "",
      table(
        ["Statement (successful attempt)", "Time"],
        result.statements.map((statement) => [
          statement.label,
          ms(statement.ms),
        ])
      ),
      "",
      `Locks held before commit: ${result.locks.map(lockText).join("; ")}.`,
      "",
      table(
        [
          "Ancestor",
          "relfilenode unchanged",
          "seq_scan delta (all sessions)",
          "seq scans by the change set",
          "Subtree check validated",
        ],
        result.ancestors.map((ancestor) => [
          ancestor.table,
          yesNo(ancestor.after.relfilenode === ancestor.before.relfilenode),
          String(ancestor.after.seqScan - ancestor.before.seqScan),
          String(ancestor.transactionSeqScans),
          yesNo(ancestor.checkValidated),
        ])
      ),
      "",
      `A record of the new class inserts through all levels: ${yesNo(result.newRecordInserted)}; a root row with a foreign class is refused with ${result.foreignClassRefused ?? "nothing"}.`,
      ...(result.waitingReads === null
        ? []
        : [
            "",
            `While the first attempt waited: a plain read of the root took ${ms(result.waitingReads.plainReadMs)} (queued behind the waiting ALTER), an STD request reading the root took ${ms(result.waitingReads.requestMs)} (waiting on CONFIG_KEY).`,
          ]),
      "",
      `No ancestor scanned or rewritten by the change set: ${verdict(
        result.ancestors.every(
          (ancestor) =>
            ancestor.after.relfilenode === ancestor.before.relfilenode &&
            ancestor.transactionSeqScans === 0
        )
      )}`,
      "",
    ]),
  ].join("\n");

const renderCasefold = (record: ProbeRecord<CasefoldProbeResult>): string => {
  const { result } = record;

  return [
    "## Probe 4: casefold is IMMUTABLE and indexable",
    "",
    conditionsLine(record),
    "",
    `\`pg_proc.provolatile\` of \`casefold(text)\`: \`${result.provolatile}\`. Database collation: ${result.defaultCollation}.`,
    "",
    table(
      [
        "Input",
        "casefold under the default collation",
        "casefold(... COLLATE pg_unicode_fast)",
      ],
      result.foldExamples.map((example) => [
        example.input,
        example.defaultCollation,
        example.unicodeFast,
      ])
    ),
    "",
    `Expression index on \`casefold(name COLLATE pg_unicode_fast)\` over ${result.rows} rows, built concurrently in ${ms(result.indexBuildMs)}. EXPLAIN of the literal form: ${result.planNodes.join(" > ")} using ${result.planIndexes.join(", ")}. ${result.boundLookups} bound-parameter lookups through request transactions found ${result.boundMatches} rows; idx_scan +${result.idxScanDelta}, seq_scan +${result.seqScanDelta}.`,
    "",
    table(
      ["First key", "Second key", "Second insert"],
      result.collisions.map((collision) => [
        collision.first,
        collision.second,
        collision.sqlState === null
          ? "accepted"
          : `refused ${collision.sqlState} (${collision.constraint ?? ""})`,
      ])
    ),
    "",
    verdict(
      result.provolatile === "i" &&
        result.planIndexes.length > 0 &&
        result.seqScanDelta === 0 &&
        result.collisions.every((collision) => collision.sqlState === "23505")
    ),
  ].join("\n");
};

const renderAddColumn = (record: ProbeRecord<AddColumnProbeResult>): string =>
  [
    "## Probe 5: ADD COLUMN on a populated table",
    "",
    conditionsLine(record),
    "",
    table(
      [
        "Column",
        "Rows",
        "ALTER TABLE",
        "Whole config commit",
        "relfilenode unchanged",
        "seq_scan delta",
        `Under ${ADD_COLUMN_BOUND_MS} ms`,
      ],
      record.result.cases.map((measured) => [
        `\`${measured.statement.replace(/^ALTER TABLE \S+ ADD COLUMN /u, "")}\``,
        String(measured.rows),
        ms(measured.statementMs),
        ms(measured.commitMs),
        yesNo(measured.relfilenodeAfter === measured.relfilenodeBefore),
        String(measured.seqScanAfter - measured.seqScanBefore),
        yesNo(measured.statementMs < ADD_COLUMN_BOUND_MS),
      ])
    ),
    "",
    `Catalog-only cases: no rewrite, no scan, under ${ADD_COLUMN_BOUND_MS} ms: ${verdict(
      record.result.cases
        .filter((measured) => measured.expectedCatalogOnly)
        .every(
          (measured) =>
            measured.relfilenodeAfter === measured.relfilenodeBefore &&
            measured.seqScanAfter === measured.seqScanBefore &&
            measured.statementMs < ADD_COLUMN_BOUND_MS
        )
    )} The volatile contrast case is detected as a rewrite: ${verdict(
      record.result.cases
        .filter((measured) => !measured.expectedCatalogOnly)
        .every(
          (measured) => measured.relfilenodeAfter !== measured.relfilenodeBefore
        )
    )}`,
  ].join("\n");

const renderNotify = (record: ProbeRecord<NotifyProbeResult>): string => {
  const { result } = record;

  return [
    "## Probe 6: save throughput with and without an in-transaction NOTIFY",
    "",
    conditionsLine(record),
    "",
    `${result.options.clients} clients, ${result.options.records} root rows, ${result.options.durationMs / 1000} s per run after ${result.options.warmupMs / 1000} s warmup. Each save: \`begin_request()\`, root row \`FOR NO KEY UPDATE\`, version bump with version check, change entry insert; then either \`pg_notify\` inside the transaction or the debounced wake-up after commit.`,
    "",
    table(
      [
        "Run",
        "Saves",
        "Saves/s",
        "p50",
        "p95",
        "p99",
        "max",
        "Failed",
        "Notifications",
      ],
      result.runs.map((run) => [
        run.variant,
        String(run.saves),
        String(round(run.savesPerSecond, 0)),
        ...summaryCells(run.latency),
        String(run.failed),
        String(run.notifications),
      ])
    ),
    "",
    `In-transaction NOTIFY throughput relative to after-commit: ${round(result.throughputRatio * 100, 1)}%.`,
  ].join("\n");
};

const renderEnvironment = (report: ProbeReport): string => {
  const env = report.environment;

  return [
    `# Platform probe results (${report.mode})`,
    "",
    `Started ${report.startedAt}, finished ${report.finishedAt}. Produced by \`pnpm probes\` (\`packages/probes/src/main.ts\`).`,
    "",
    `Host: ${env.cpu}, ${env.cores} logical CPUs, ${env.memoryGiB} GiB RAM, ${env.os}, Node ${env.node}. Postgres: ${env.postgresVersion}, in Docker on the same host, shared with other agents' test runs (see each probe's load line).`,
    "",
    table(
      ["Setting", "Value"],
      Object.entries(env.settings).map(([name, value]) => [name, value])
    ),
  ].join("\n");
};

/**
 * Renders a report as Markdown.
 * @param report - The run's results.
 * @returns The Markdown document.
 */
export const renderMarkdown = (report: ProbeReport): string =>
  [
    renderEnvironment(report),
    report.configPause === null
      ? undefined
      : renderConfigPause(report.configPause),
    report.killedBuild === null
      ? undefined
      : renderKilledBuild(report.killedBuild),
    report.addClass === null ? undefined : renderAddClass(report.addClass),
    report.casefold === null ? undefined : renderCasefold(report.casefold),
    report.addColumn === null ? undefined : renderAddColumn(report.addColumn),
    report.notify === null ? undefined : renderNotify(report.notify),
  ]
    .filter((section) => section !== undefined)
    .join("\n\n")
    .concat("\n");
