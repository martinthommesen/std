/**
 * Summarizes ODA Canvas probe results (`result.json` of
 * `deploy/oda/probe/probe.sh`, docs/decisions/0027-oda-canvas-probe.md) as
 * Markdown: the failure rate and failing phases, and the median and p90 of
 * each phase's duration and of the disk the probe uses.
 */
import { Schema } from "effect";

const DiskSchema = Schema.Struct({
  availableBytes: Schema.Finite,
  usedBytes: Schema.Finite,
});

/** The parts of a probe's `result.json` that the summary reads. */
export const ProbeResultSchema = Schema.Struct({
  disk: Schema.Struct({
    before: DiskSchema,
    kindNode: Schema.optionalKey(
      Schema.Struct({
        nodeImageBytes: Schema.NullOr(Schema.Finite),
        nodeVarBytes: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
        nodeWritableBytes: Schema.NullOr(Schema.Finite),
      })
    ),
    peakUsedBytes: Schema.Finite,
  }),
  failedPhase: Schema.NullOr(Schema.String),
  failureExcerpt: Schema.NullOr(Schema.String),
  gateway: Schema.NullOr(Schema.Struct({ ok: Schema.Boolean })),
  outcome: Schema.Literals(["success", "failure"]),
  phases: Schema.Array(
    Schema.Struct({
      durationSeconds: Schema.optionalKey(Schema.Finite),
      name: Schema.String,
      status: Schema.Literals(["success", "failure", "skipped"]),
    })
  ),
  runner: Schema.Struct({
    imageOS: Schema.String,
    imageVersion: Schema.String,
    os: Schema.String,
  }),
  schemaVersion: Schema.Literal(1),
  startedAt: Schema.String,
});

/** The parts of a probe's `result.json` that the summary reads. */
export type ProbeResult = typeof ProbeResultSchema.Type;

/** Decodes the text of a `result.json`. */
export const decodeProbeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProbeResultSchema)
);

/** One probe run: a GitHub Actions run or a local result file. */
export interface ProbeRun {
  /** The run's ID or the local file's path. */
  readonly id: string;
  /** The workflow run's conclusion, such as `success`, or `local`. */
  readonly conclusion: string;
  /** Absent when the run left no readable result (cancelled, timed out). */
  readonly result?: ProbeResult;
  readonly url?: string;
}

/** The phases that bring a Canvas up, in order; their sum is the bring-up. */
export const bringUpPhases = ["cluster", "istio", "canvas", "component"];

/**
 * The median: the middle value, or the mean of the two middle values.
 *
 * @param values - At least one value.
 * @returns The median.
 */
export const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;

  if (sorted.length % 2 === 1) {
    return upper;
  }

  return ((sorted[middle - 1] ?? Number.NaN) + upper) / 2;
};

/**
 * A percentile by the nearest-rank method: the smallest value with at least
 * `p` of the values at or below it. With 10 values, p90 is the 9th smallest.
 *
 * @param values - At least one value.
 * @param p - The fraction, such as 0.9.
 * @returns The percentile.
 */
export const nearestRank = (values: readonly number[], p: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));

  return sorted[rank - 1] ?? Number.NaN;
};

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

const seconds = (value: number): string => `${Math.round(value)} s`;

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;

interface Spread {
  readonly count: number;
  readonly max: number;
  readonly median: number;
  readonly p90: number;
}

const spread = (values: readonly number[]): Spread | undefined =>
  values.length === 0
    ? undefined
    : {
        count: values.length,
        max: Math.max(...values),
        median: median(values),
        p90: nearestRank(values, 0.9),
      };

const spreadCells = (
  values: readonly number[],
  format: (value: number) => string
): string => {
  const found = spread(values);

  return found === undefined
    ? "| 0 | | | |"
    : `| ${found.count} | ${format(found.median)} | ${format(found.p90)} | ${format(found.max)} |`;
};

const phaseDuration = (
  result: ProbeResult,
  name: string
): number | undefined => {
  const phase = result.phases.find((entry) => entry.name === name);

  return phase?.status === "success" ? phase.durationSeconds : undefined;
};

const defined = (values: readonly (number | null | undefined)[]): number[] =>
  values.filter(
    (value): value is number => value !== undefined && value !== null
  );

const phaseNames = (results: readonly ProbeResult[]): string[] => {
  const names = new Set<string>();

  for (const result of results) {
    for (const phase of result.phases) {
      names.add(phase.name);
    }
  }

  return [...names];
};

const bringUpSeconds = (result: ProbeResult): number | undefined => {
  let total = 0;

  for (const name of bringUpPhases) {
    const duration = phaseDuration(result, name);

    if (duration === undefined) {
      return undefined;
    }

    total += duration;
  }

  return total;
};

const outcomeCell = (run: ProbeRun): string =>
  run.result?.outcome ?? `no result (${run.conclusion})`;

const excerptTail = (excerpt: string | null, lines: number): string =>
  (excerpt ?? "(no log excerpt)").split("\n").slice(-lines).join("\n");

const runLabel = (run: ProbeRun): string =>
  run.url === undefined ? `\`${run.id}\`` : `[${run.id}](${run.url})`;

const outcomeLines = (runs: readonly ProbeRun[]): string[] => {
  const withResult = runs.filter((run) => run.result !== undefined);
  const failed = withResult.filter((run) => run.result?.outcome === "failure");
  const missing = runs.length - withResult.length;
  const failures = failed.length + missing;
  const byPhase = new Map<string, number>();

  for (const run of failed) {
    const phase = run.result?.failedPhase ?? "unknown";

    byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1);
  }

  if (missing > 0) {
    byPhase.set("no result (run cancelled or timed out)", missing);
  }

  const phases = [...byPhase.entries()]
    .map(([phase, count]) => `${phase} ${count}`)
    .join(", ");

  return [
    `- Runs: ${runs.length}; succeeded ${runs.length - failures}, failed ${failures} (failure rate ${percent(failures, runs.length)}).`,
    `- Failing phases: ${phases === "" ? "none" : phases}.`,
  ];
};

const phaseTable = (results: readonly ProbeResult[]): string[] => {
  const succeeded = results.filter((result) => result.outcome === "success");

  const rows = phaseNames(results).map((name) => {
    const failures = results.filter(
      (result) => result.failedPhase === name
    ).length;

    const durations = defined(
      results.map((result) => phaseDuration(result, name))
    );

    return `| ${name} ${spreadCells(durations, seconds)} ${failures} |`;
  });

  const bringUp = defined(succeeded.map(bringUpSeconds));

  return [
    "| Phase | Succeeded | Median | p90 | Max | Failed here |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    `| bring-up (${bringUpPhases.join(" + ")}), successful runs ${spreadCells(bringUp, seconds)} |`,
  ];
};

const diskTable = (results: readonly ProbeResult[]): string[] => [
  "| Disk | Runs | Median | p90 | Max |",
  "| --- | --- | --- | --- | --- |",
  `| free before the probe ${spreadCells(
    results.map((result) => result.disk.before.availableBytes),
    gigabytes
  )}`,
  `| peak use above the start (root file system) ${spreadCells(
    results.map(
      (result) => result.disk.peakUsedBytes - result.disk.before.usedBytes
    ),
    gigabytes
  )}`,
  `| kind node: /var (pulled images, etcd, logs) ${spreadCells(
    defined(results.map((result) => result.disk.kindNode?.nodeVarBytes)),
    gigabytes
  )}`,
  `| kind node: container's writable layer ${spreadCells(
    defined(results.map((result) => result.disk.kindNode?.nodeWritableBytes)),
    gigabytes
  )}`,
  `| kind node: image ${spreadCells(
    defined(results.map((result) => result.disk.kindNode?.nodeImageBytes)),
    gigabytes
  )}`,
];

/**
 * Renders the summary of some probe runs as Markdown.
 *
 * @param runs - The runs, newest first.
 * @returns The Markdown text.
 */
export const summarize = (runs: readonly ProbeRun[]): string => {
  const results = runs.flatMap((run) =>
    run.result === undefined ? [] : [run.result]
  );

  const images = [
    ...new Set(
      results.map((result) =>
        result.runner.imageVersion === ""
          ? result.runner.os
          : `${result.runner.imageOS} ${result.runner.imageVersion} (${result.runner.os})`
      )
    ),
  ];

  const gatewayOk = results.filter(
    (result) => result.gateway?.ok === true
  ).length;

  const failures = runs.filter((run) => run.result?.outcome !== "success");

  return [
    `# ODA Canvas probe: ${runs.length} run${runs.length === 1 ? "" : "s"}`,
    "",
    ...outcomeLines(runs),
    `- Runner images: ${images.length === 0 ? "unknown" : images.join("; ")}.`,
    `- Exposed API answered through the Canvas gateway (not gating): ${gatewayOk} of ${results.length}.`,
    "",
    "Durations in seconds; p90 by nearest rank. A phase's numbers count only the runs in which it succeeded.",
    "",
    ...phaseTable(results),
    "",
    ...diskTable(results),
    "",
    "## Runs",
    "",
    "| Run | Started | Outcome | Failed phase |",
    "| --- | --- | --- | --- |",
    ...runs.map(
      (run) =>
        `| ${runLabel(run)} | ${run.result?.startedAt ?? ""} | ${outcomeCell(run)} | ${run.result?.failedPhase ?? ""} |`
    ),
    ...(failures.length === 0
      ? []
      : [
          "",
          "## Failures",
          ...failures.flatMap((run) => [
            "",
            `${runLabel(run)}, phase ${run.result?.failedPhase ?? "unknown"}:`,
            "",
            "```text",
            excerptTail(run.result?.failureExcerpt ?? null, 15),
            "```",
          ]),
        ]),
    "",
  ].join("\n");
};
