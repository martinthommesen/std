/**
 * Summarizes ODA Canvas probe results (`result.json` of
 * `deploy/oda/probe/probe.sh`, docs/decisions/0027-oda-canvas-probe.md) as
 * Markdown: the failure rate and failing phases, and the median and p90 of
 * each phase's duration and of the disk the probe uses.
 *
 * The unit is one probe attempt: every attempt of a selected workflow run
 * counts, so a rerun never hides an earlier failure. An attempt fails when
 * its result says so, and also when it has no result, an unreadable one, or
 * one that names another run, attempt or commit.
 */
import { Result, Schema } from "effect";

const DiskSchema = Schema.Struct({
  availableBytes: Schema.Finite,
  usedBytes: Schema.Finite,
});

/** The parts of a probe's `result.json` that the summary reads. */
export const ProbeResultSchema = Schema.Struct({
  disk: Schema.Struct({
    before: DiskSchema,
    kindNode: Schema.NullOr(
      Schema.Struct({
        nodeImageBytes: Schema.NullOr(Schema.Finite),
        nodeVarBytes: Schema.NullOr(Schema.Finite),
        nodeWritableBytes: Schema.NullOr(Schema.Finite),
      })
    ),
    minAvailableBytes: Schema.Finite,
    peakUsedBytes: Schema.Finite,
    sampleIntervalSeconds: Schema.Finite,
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
  pins: Schema.Record(Schema.String, Schema.String),
  run: Schema.Struct({
    githubActions: Schema.Boolean,
    probeSha256: Schema.String,
    runAttempt: Schema.String,
    runId: Schema.String,
    sha: Schema.String,
    stubChartSha256: Schema.String,
  }),
  runner: Schema.Struct({
    imageOS: Schema.String,
    imageVersion: Schema.String,
    os: Schema.String,
  }),
  schemaVersion: Schema.Literal(1),
  stage: Schema.Literals(["partial", "complete"]),
  startedAt: Schema.String,
});

/** The parts of a probe's `result.json` that the summary reads. */
export type ProbeResult = typeof ProbeResultSchema.Type;

const decodeResultText = Schema.decodeUnknownResult(
  Schema.fromJsonString(ProbeResultSchema)
);

/**
 * Decodes the text of a `result.json`.
 *
 * @param text - The file's text.
 * @returns The result, or the decode error's message.
 */
export const decodeProbeResult = (
  text: string
): Result.Result<ProbeResult, string> => {
  const decoded = decodeResultText(text);

  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(decoded.failure.message);
};

/** Where an attempt came from: a workflow run's attempt, or a local file. */
export interface AttemptSource {
  /** The run's ID, or the local file's path. */
  readonly runId: string;
  /** The attempt number; 1 for a local file. */
  readonly attempt: number;
  /** The attempt's conclusion on GitHub, such as `success`, or `local`. */
  readonly conclusion: string;
  /** The commit the attempt ran; absent for a local file. */
  readonly headSha?: string;
  readonly url?: string;
}

/** One probe attempt and what it left. */
export interface ProbeAttempt extends AttemptSource {
  readonly result?: ProbeResult;
  /** Why the attempt has no usable result; it then counts as a failure. */
  readonly problem?: string;
}

/**
 * Checks that a result belongs to the run attempt it was downloaded for.
 *
 * @param source - The attempt on GitHub.
 * @param result - The result found in its artifact.
 * @returns The mismatch, or undefined when the result belongs to it.
 */
export const provenanceProblem = (
  source: AttemptSource,
  result: ProbeResult
): string | undefined => {
  const expected = [
    ["githubActions", "true", String(result.run.githubActions)],
    ["runId", source.runId, result.run.runId],
    ["runAttempt", String(source.attempt), result.run.runAttempt],
    ["sha", source.headSha ?? "", result.run.sha],
  ];

  const mismatches = expected.flatMap(([field, want, found]) =>
    want === found ? [] : [`${field} ${found} (expected ${want})`]
  );

  return mismatches.length === 0
    ? undefined
    : `provenance mismatch: ${mismatches.join(", ")}`;
};

/**
 * What decides whether two results measured the same thing: the probe
 * script, the stub chart and the pins (versions and checksums).
 *
 * @param result - A result.
 * @returns A key equal for comparable results.
 */
export const configurationKey = (result: ProbeResult): string =>
  JSON.stringify({
    pins: Object.entries(result.pins).toSorted(([a], [b]) =>
      a.localeCompare(b)
    ),
    probe: result.run.probeSha256,
    stub: result.run.stubChartSha256,
  });

const shortHash = (text: string): string => {
  // FNV-1a, only to label configurations in the table.
  let hash = 0x81_1c_9d_c5;

  for (const char of text) {
    // oxlint-disable-next-line no-bitwise -- FNV-1a is defined on 32-bit words
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01_00_01_93) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
};

/**
 * The distinct configurations among the attempts' results.
 *
 * @param attempts - The attempts.
 * @returns A short label per configuration key.
 */
export const configurations = (
  attempts: readonly ProbeAttempt[]
): Map<string, string> => {
  const labels = new Map<string, string>();

  for (const attempt of attempts) {
    if (attempt.result !== undefined) {
      const key = configurationKey(attempt.result);

      labels.set(key, shortHash(key));
    }
  }

  return labels;
};

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

/**
 * A usable result: present, and no problem with it.
 *
 * @param attempt - The attempt.
 * @returns Its result, or undefined.
 */
const usable = (attempt: ProbeAttempt): ProbeResult | undefined =>
  attempt.problem === undefined ? attempt.result : undefined;

// Conclusions of an attempt that ran to its end: GitHub's, or a local file.
const cleanConclusions = new Set(["success", "local"]);

/**
 * An attempt succeeded when its deployment reached `Complete`, its complete
 * result was published, and the run attempt itself succeeded. A partial
 * result means the complete one could not be written (the probe then exits
 * 3), so it is a failure, whatever the deployment did.
 *
 * @param attempt - The attempt.
 * @returns True for a success.
 */
const succeeded = (attempt: ProbeAttempt): boolean => {
  const result = usable(attempt);

  return (
    result?.outcome === "success" &&
    result.stage === "complete" &&
    cleanConclusions.has(attempt.conclusion)
  );
};

const deployed = (attempt: ProbeAttempt): boolean =>
  usable(attempt)?.outcome === "success";

/**
 * Why an attempt failed, for the failure-phase count.
 *
 * @param attempt - A failed attempt.
 * @returns The failed phase or the kind of problem.
 */
const failureReason = (attempt: ProbeAttempt): string => {
  if (attempt.problem !== undefined) {
    return attempt.problem.startsWith("provenance")
      ? "result of another run (provenance mismatch)"
      : "no usable result";
  }

  const { result } = attempt;

  if (result?.failedPhase !== undefined && result.failedPhase !== null) {
    return result.failedPhase;
  }

  if (result?.stage === "partial") {
    return "result not published (stage partial)";
  }

  return result?.outcome === "success"
    ? `run attempt concluded ${attempt.conclusion}`
    : "unknown";
};

const outcomeCell = (attempt: ProbeAttempt): string => {
  if (attempt.problem !== undefined) {
    return `no usable result (${attempt.conclusion})`;
  }

  if (attempt.result === undefined) {
    return `no result (${attempt.conclusion})`;
  }

  return succeeded(attempt)
    ? "success"
    : `failure (deployment ${attempt.result.outcome}, ${attempt.result.stage} result, conclusion ${attempt.conclusion})`;
};

const excerptTail = (excerpt: string | null, lines: number): string =>
  (excerpt ?? "(no log excerpt)").split("\n").slice(-lines).join("\n");

const attemptLabel = (attempt: ProbeAttempt): string => {
  const name = `${attempt.runId} #${attempt.attempt}`;

  return attempt.url === undefined
    ? `\`${name}\``
    : `[${name}](${attempt.url})`;
};

const outcomeLines = (attempts: readonly ProbeAttempt[]): string[] => {
  const failures = attempts.filter((attempt) => !succeeded(attempt));
  const runs = new Set(attempts.map((attempt) => attempt.runId)).size;
  const byReason = new Map<string, number>();

  for (const attempt of failures) {
    const reason = failureReason(attempt);

    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  const reasons = [...byReason.entries()]
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");

  return [
    `- Attempts: ${attempts.length} in ${runs} run${runs === 1 ? "" : "s"}; succeeded ${attempts.length - failures.length}, failed ${failures.length} (failure rate ${percent(failures.length, attempts.length)}).`,
    `- Failing phases: ${reasons === "" ? "none" : reasons}.`,
    `- Deployments that reached \`Complete\` by their results, publication aside: ${attempts.filter(deployed).length} of ${attempts.length}.`,
  ];
};

const phaseTable = (results: readonly ProbeResult[]): string[] => {
  const rows = phaseNames(results).map((name) => {
    const failures = results.filter(
      (result) => result.failedPhase === name
    ).length;

    const durations = defined(
      results.map((result) => phaseDuration(result, name))
    );

    return `| ${name} ${spreadCells(durations, seconds)} ${failures} |`;
  });

  const bringUp = defined(
    results.flatMap((result) =>
      result.outcome === "success" ? [bringUpSeconds(result)] : []
    )
  );

  return [
    "| Phase | Succeeded | Median | p90 | Max | Failed here |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    `| bring-up (${bringUpPhases.join(" + ")}), successful attempts ${spreadCells(bringUp, seconds)} |`,
  ];
};

const diskTable = (results: readonly ProbeResult[]): string[] => [
  "| Disk | Attempts | Median | p90 | Max |",
  "| --- | --- | --- | --- | --- |",
  `| free before the probe ${spreadCells(
    results.map((result) => result.disk.before.availableBytes),
    gigabytes
  )}`,
  `| peak use above the start (sampled) ${spreadCells(
    results.map(
      (result) => result.disk.peakUsedBytes - result.disk.before.usedBytes
    ),
    gigabytes
  )}`,
  `| least free during the probe (sampled) ${spreadCells(
    results.map((result) => result.disk.minAvailableBytes),
    gigabytes
  )}`,
  `| kind node: /var at the end (images, etcd, logs) ${spreadCells(
    defined(results.map((result) => result.disk.kindNode?.nodeVarBytes)),
    gigabytes
  )}`,
  `| kind node: image ${spreadCells(
    defined(results.map((result) => result.disk.kindNode?.nodeImageBytes)),
    gigabytes
  )}`,
];

const configurationLines = (
  attempts: readonly ProbeAttempt[],
  labels: ReadonlyMap<string, string>
): string[] => {
  const commits = new Set(
    attempts.flatMap((attempt) =>
      attempt.result === undefined ? [] : [attempt.result.run.sha]
    )
  );

  const lines = [
    `- Commits: ${commits.size === 0 ? "none" : [...commits].map((sha) => sha.slice(0, 12)).join(", ")}.`,
    `- Configurations (probe script, stub chart, pins): ${labels.size === 0 ? "none" : [...labels.values()].join(", ")}.`,
  ];

  if (labels.size > 1) {
    lines.push(
      "- **Warning: the attempts ran different probe scripts, stub charts or pins; their numbers are not comparable.**"
    );
  }

  return lines;
};

const configurationCell = (
  attempt: ProbeAttempt,
  labels: ReadonlyMap<string, string>
): string =>
  attempt.result === undefined
    ? ""
    : (labels.get(configurationKey(attempt.result)) ?? "");

const runsTable = (
  attempts: readonly ProbeAttempt[],
  labels: ReadonlyMap<string, string>
): string[] => [
  "| Attempt | Commit | Configuration | Started | Outcome | Failed phase |",
  "| --- | --- | --- | --- | --- | --- |",
  ...attempts.map(
    (attempt) =>
      `| ${attemptLabel(attempt)} | ${(attempt.result?.run.sha ?? attempt.headSha ?? "").slice(0, 12)} | ${configurationCell(attempt, labels)} | ${attempt.result?.startedAt ?? ""} | ${outcomeCell(attempt)} | ${attempt.result?.failedPhase ?? ""} |`
  ),
];

const failureHeading = (attempt: ProbeAttempt): string => {
  if (attempt.problem !== undefined) {
    return attempt.problem;
  }

  const phase = attempt.result?.failedPhase;

  return phase === undefined || phase === null
    ? failureReason(attempt)
    : `phase ${phase}`;
};

const failureSection = (attempts: readonly ProbeAttempt[]): string[] => {
  const failures = attempts.filter((attempt) => !succeeded(attempt));

  if (failures.length === 0) {
    return [];
  }

  return [
    "",
    "## Failures",
    ...failures.flatMap((attempt) => [
      "",
      `${attemptLabel(attempt)}, ${failureHeading(attempt)}:`,
      "",
      "```text",
      excerptTail(attempt.result?.failureExcerpt ?? null, 15),
      "```",
    ]),
  ];
};

/**
 * Renders the summary of some probe attempts as Markdown.
 *
 * @param attempts - The attempts, newest run first.
 * @returns The Markdown text.
 */
export const summarize = (attempts: readonly ProbeAttempt[]): string => {
  const results = attempts.flatMap((attempt) => {
    const result = usable(attempt);

    return result === undefined ? [] : [result];
  });

  const labels = configurations(
    attempts.filter((attempt) => usable(attempt) !== undefined)
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

  return [
    `# ODA Canvas probe: ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}`,
    "",
    ...outcomeLines(attempts),
    ...configurationLines(attempts, labels),
    `- Runner images: ${images.length === 0 ? "unknown" : images.join("; ")}.`,
    `- Exposed API answered through the Canvas gateway (not gating): ${gatewayOk} of ${results.length}.`,
    "",
    "Durations in seconds; p90 by nearest rank. A phase's numbers count only the attempts in which it succeeded. Disk is sampled every few seconds during the probe (the result says how often).",
    "",
    ...phaseTable(results),
    "",
    ...diskTable(results),
    "",
    "## Attempts",
    "",
    ...runsTable(attempts, labels),
    ...failureSection(attempts),
    "",
  ].join("\n");
};
