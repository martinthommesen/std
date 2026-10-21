/**
 * Writes `results/<yyyy-mm-dd>-<name>.md` and `.json`: the results table,
 * writes, sizes, generation times, environment and load, definitions, the
 * decision, and the plan of each read's median run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { restrictedRules } from "./access.ts";
import type { Options } from "./cli.ts";
import { BenchError } from "./errors.ts";
import { classes, ticketClass } from "./hierarchy.ts";
import type { ReadResult, StatementPlan } from "./measure.ts";
import type { BenchReport, DecisionStep, ModelRun } from "./results.ts";
import type { TableSize } from "./sizes.ts";
import { budgets, reads, writeBudgetMs } from "./workload.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const bytesPerMiB = 1024 * 1024;
const secondsPerMinute = 60;
const percentPerSlot = 5;
const over = "**over**";

const mib = (bytes: number): string => (bytes / bytesPerMiB).toFixed(0);

const duration = (seconds: number): string => {
  if (seconds < secondsPerMinute) {
    return `${seconds.toFixed(1)} s`;
  }

  const minutes = Math.floor(seconds / secondsPerMinute);

  return `${minutes} min ${Math.round(seconds % secondsPerMinute)} s`;
};

const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[]
): string =>
  [
    row(header),
    row(header.map(() => "---")),
    ...rows.map((cells) => row(cells)),
  ].join("\n");

const fileName = (options: Options): string => {
  if (options.mode !== "custom") {
    return options.mode;
  }

  const scales = options.scales.map((scale) => scale.label).join("+");
  const suffix = options.mitigations ? "-mitigations" : "";

  return `custom-${options.models.join("+")}-${scales}${suffix}`;
};

const timing = (p50: number, p95: number, budget: number): string => {
  const flag = p95 <= budget ? "" : ` ${over}`;

  return `${p50} / ${p95}${flag}`;
};

const readCell = (run: ModelRun, name: string, budget: number): string => {
  const result = run.reads.find((read) => read.name === name);

  return result === undefined ? "" : timing(result.p50, result.p95, budget);
};

const readsTable = (runs: readonly ModelRun[]): string => {
  const header = [
    "Read",
    "Caller",
    "Endpoint",
    "Budget p95",
    ...runs.map((run) => run.label),
  ];

  const rows = reads.map((def) => {
    const budget = budgets[def.query];
    const name = def.decisive ? `**${def.name}**` : def.name;

    return [
      name,
      def.caller,
      def.endpoint,
      `${budget}`,
      ...runs.map((run) => readCell(run, def.name, budget)),
    ];
  });

  return table(header, rows);
};

const writesTable = (runs: readonly ModelRun[]): string => {
  const rows = runs.flatMap((run) =>
    run.writes.map((write) => {
      const flag = write.p95 <= writeBudgetMs ? "" : ` ${over}`;

      const seconds = write.exhausted
        ? `${write.seconds} (W1 records used up)`
        : `${write.seconds}`;

      return [
        run.label,
        write.name,
        write.caller,
        `${write.throughput}`,
        `${write.p50}`,
        `${write.p95}${flag}`,
        `${write.operations}`,
        `${write.errors}`,
        `${write.refused}`,
        seconds,
      ];
    })
  );

  return table(
    [
      "Run",
      "Write",
      "Caller",
      "ops/s",
      "p50 ms",
      "p95 ms",
      "Operations",
      "Errors",
      "Refused by rules",
      "Seconds",
    ],
    rows
  );
};

const sizeRow = (size: TableSize): readonly string[] => [
  size.table,
  `${size.rows}`,
  mib(size.tableBytes),
  mib(size.indexBytes),
  mib(size.totalBytes),
  `${size.indexes}`,
];

const sizesSection = (run: ModelRun): string => {
  let tableBytes = 0;
  let indexBytes = 0;
  let totalBytes = 0;

  for (const size of run.sizes) {
    tableBytes += size.tableBytes;
    indexBytes += size.indexBytes;
    totalBytes += size.totalBytes;
  }

  const total = [
    "**total**",
    "",
    mib(tableBytes),
    mib(indexBytes),
    `**${mib(totalBytes)}**`,
    "",
  ];

  return [
    `### ${run.label}`,
    "",
    table(
      [
        "Table",
        "Rows (estimate)",
        "Table MiB",
        "Indexes MiB",
        "Total MiB",
        "Indexes",
      ],
      [...run.sizes.map(sizeRow), total]
    ),
  ].join("\n");
};

const generationSection = (run: ModelRun): string => {
  const body =
    run.generation.steps.length === 0
      ? "Database reused (`--reuse`); generation not timed."
      : table(
          ["Step", "Seconds"],
          run.generation.steps.map((step) => [
            step.name,
            step.seconds.toFixed(1),
          ])
        );

  return [
    `### ${run.label} (${run.database}), total ${duration(run.generation.totalSeconds)}`,
    "",
    body,
  ].join("\n");
};

const stepText = (step: DecisionStep, index: number): string => {
  const budgetRows = step.budgets.map((check) => [
    check.name,
    `${check.p95}`,
    `${check.budget}`,
    check.pass ? "ok" : over,
  ]);

  const comparisonRows = step.comparisons.map((comparison) => [
    comparison.query,
    `${comparison.classTableP95}`,
    `${comparison.baselineP95}`,
    `${comparison.ratio}`,
    comparison.baselineMoreThan2xFaster ? "**yes**" : "no",
  ]);

  const meets = step.meetsBudgets ? "yes" : "**no**";
  const satisfied = step.keep ? "**yes**" : "**no**";

  const supplementary = step.supplementaryMisses
    .map((check) => `${check.name} (${check.p95} ms)`)
    .join(", ");

  return [
    `### Step ${index + 1}: ${step.classTable} against ${step.baseline}`,
    "",
    table(["Request", "p95 ms", "Budget ms", "Result"], budgetRows),
    "",
    table(
      [
        "Query",
        "class-table p95",
        "baseline p95",
        "ratio",
        "baseline more than 2x faster",
      ],
      comparisonRows
    ),
    "",
    `Meets every budget: ${meets}. Read queries where the baseline is more than 2x faster: ${step.baselineFasterCount} (at most 1 allowed). Rule satisfied: ${satisfied}.`,
    "",
    step.problems.length === 0
      ? "Measurements complete: every decisive read measured, every write phase error-free and run for its full duration."
      : `**Not judged.** ${step.problems.join("; ")}.`,
    ...(supplementary === ""
      ? []
      : [
          "",
          `Supplementary (non-decisive) requests over budget: ${supplementary}.`,
        ]),
  ].join("\n");
};

const decisionSection = (report: BenchReport): string => {
  const { decision } = report;

  if (decision === null) {
    return "No decision: the decision rule needs class-table and one table per hierarchy at 10m in the same run.";
  }

  return [
    `**Outcome: ${decision.outcome}.** ${decision.summary}`,
    "",
    ...decision.steps.map(stepText),
  ].join("\n\n");
};

const loadRows = (runs: readonly ModelRun[]): readonly (readonly string[])[] =>
  runs.flatMap((run) =>
    run.load.map((window) => [
      run.label,
      window.phase,
      `${window.seconds}`,
      `${window.hostBusyCores}`,
      `${window.benchContainerCores ?? "n/a"}`,
      `${window.harnessCores}`,
      `${window.otherCores ?? "n/a"}`,
      `${window.loadAverageStart.join(" ")} -> ${window.loadAverageEnd.join(" ")}`,
      `${window.containerThrottledPeriods ?? "n/a"}`,
    ])
  );

const environmentSection = (report: BenchReport): string => {
  const { host, postgres } = report;

  const others =
    host.otherContainers.length === 0
      ? "none"
      : host.otherContainers.join(", ");

  const settings = postgres.settings.map((setting) => [
    setting.name,
    `\`${setting.setting}\``,
    setting.source,
  ]);

  return [
    "### Hardware",
    "",
    `- CPU: ${host.cpuModel}, ${host.logicalCpus} logical CPUs on the host.`,
    `- Memory: ${host.memoryGiB} GiB on the host.`,
    `- Bench container limits: ${host.containerCpus ?? "n/a"} CPUs (CFS quota, not pinned), ${host.containerMemoryGiB ?? "n/a"} GiB memory.`,
    `- Kernel: ${host.kernel}. Harness: Node ${host.node}.`,
    "",
    "```text",
    host.lscpu,
    "",
    host.disks,
    "",
    host.raid,
    "```",
    "",
    "### Postgres",
    "",
    postgres.version,
    "",
    table(["Setting", "Value", "Source"], settings),
    "",
    "### Concurrent load",
    "",
    `Other containers on the host during the run: ${others}.`,
    "",
    'CPU use per phase in cores (CPU-seconds per second). "Other" is host busy time minus the bench container and this harness: load from other work on this shared machine.',
    "",
    table(
      [
        "Run",
        "Phase",
        "Seconds",
        "Host busy",
        "Bench container",
        "Harness",
        "Other",
        "Load average",
        "Throttled periods",
      ],
      loadRows(report.runs)
    ),
  ].join("\n");
};

const fieldSummary = (
  def: (typeof classes)[number]["fields"][number]
): string =>
  def.required
    ? `${def.name} ${def.sqlType}`
    : `${def.name} ${def.sqlType} (${def.nullPercent}% null)`;

const definitionsSection = (): string => {
  const hierarchy = classes.map((cls) => [
    `bench.${cls.name}`,
    `L${cls.level}`,
    cls.parent === null ? "" : `bench.${cls.parent}`,
    `${cls.fields.length}`,
    `${cls.slots * percentPerSlot}%`,
    cls.fields.map((def) => fieldSummary(def)).join(", "),
  ]);

  const ticketFields = ticketClass.fields.map((def) => def.name).join(", ");

  const requests = reads.map((def) => [
    def.name,
    def.caller,
    def.endpoint,
    def.decisive ? "yes" : "no",
    def.description,
  ]);

  return [
    "### Hierarchy (Contracts 2.6)",
    "",
    table(
      ["Class", "Level", "Parent", "Own fields", "Records", "Fields"],
      hierarchy
    ),
    "",
    `\`bench.ticket\` has 20% as many rows as the hierarchy; fields: ${ticketFields}; \`item\` references a random record. 50,000 users (2,500 in smoke mode) in \`core.user\`, referenced from \`item.owner\` (1% null) and the audit fields. Every record ID comes from \`uuidv7()\`.`,
    "",
    "### Callers",
    "",
    "- **admin**: the built-in allow-all rule.",
    `- **restricted**: rows where \`owner = me OR status = "${restrictedRules.sharedStatus}"\`; \`item.location\` denied when \`priority > ${restrictedRules.locationDeniedAbovePriority}\` (compiled as \`CASE WHEN <readable> THEN location END\` in selection, filters, sorts and cursors); \`bench.laptop\` records denied when \`classification = "${restrictedRules.laptopDeniedClassification}"\` (applies per class through \`class_id\`; class-table joins \`bench.laptop\` for it); tickets where \`confidential = false OR opened_by = me\`; the item reference in Q7 joins with the item's visibility as a guard. \`me\` is a random user (the record's owner for the restricted Q5 and W2).`,
    "",
    "### Requests",
    "",
    table(["Read", "Caller", "Endpoint", "Decisive", "Definition"], requests),
    "",
    "Every list selects every readable field of the endpoint, `class_id` and the owner label (Q7: the item and opener labels), and breaks ties by `id`. Q2's cursor is the 10,000th row of the same request (found by an unmeasured probe); the cursor predicate is the expanded null-aware form of Contracts 3.5 plus the redundant bound on the first key. Each read runs in its own READ COMMITTED transaction, as STD's request transactions do. Statements are prepared (the driver's default), so Postgres may switch to a generic plan after five executions; the reported plan is an `EXPLAIN ANALYZE` of the median run's parameters.",
    "",
    "- **W1**: insert a laptop through `/bench.laptop` (class-table: root row, then device, computer and laptop rows).",
    "- **W2**: update `laptop.battery_cycles`: lock the root row alone `FOR NO KEY UPDATE`, read the existing state (all levels, visibility) in the next statement, update the level row, bump the root version with a version check.",
    "- **W3**: delete a laptop through `/bench.item`: lock the root `FOR UPDATE`, read the existing state of the concrete class, delete the root row with a version check (level rows cascade). Deletes the laptops W1 created.",
    "- The restricted caller's writes add the existing-state and proposed-state checks through the compiled predicates; writes its rules refuse are counted separately and not timed.",
  ].join("\n");
};

const planBlock = (plan: StatementPlan): string =>
  [
    "```sql",
    plan.text,
    "```",
    "",
    `Parameters: \`${JSON.stringify(plan.params)}\``,
    "",
    "```text",
    plan.plan,
    "```",
    "",
  ].join("\n");

const readPlans = (read: ReadResult): string => {
  const summary = `${read.name}: p50 ${read.p50} ms, p95 ${read.p95} ms, ${read.meanRows} rows on average`;

  return [
    `<details><summary>${summary}</summary>`,
    "",
    ...read.plans.map((plan) => planBlock(plan)),
    "</details>",
    "",
  ].join("\n");
};

const plansSection = (runs: readonly ModelRun[]): string =>
  runs
    .map((run) =>
      [
        `### ${run.label}`,
        "",
        ...run.reads.map((read) => readPlans(read)),
      ].join("\n")
    )
    .join("\n");

const equivalenceSection = (report: BenchReport): readonly string[] =>
  report.equivalence === null
    ? []
    : [
        "## Cross-model equivalence",
        "",
        `${report.equivalence.length} requests returned the same IDs in the same order (and the same counts) in every model.`,
        "",
      ];

const sections = (
  title: string,
  bodies: readonly string[]
): readonly string[] =>
  bodies.length === 0
    ? []
    : [title, "", ...bodies.flatMap((body) => [body, ""])];

/**
 * Renders the Markdown results file.
 *
 * @param report - The results.
 * @returns The Markdown text.
 */
export const renderMarkdown = (report: BenchReport): string => {
  const { method } = report;

  return [
    `# STD ${report.title}`,
    "",
    `Date ${report.date}, commit \`${report.commit}\`, command \`${report.command}\`, seed ${report.seed}, total time ${duration(report.totalSeconds)}.`,
    "",
    `Method (Contracts 2.6): ${method.warmup} warm-up and ${method.runs} measured runs per decisive read (5 and 30 for the supplementary ones) with seeded random parameters, run one at a time on one connection; p50 and p95 in milliseconds measured at the client; \`EXPLAIN (ANALYZE, BUFFERS)\` of the median run; writes with ${method.writeClients} clients for ${method.writeSeconds} s each. Stage 0 queries are hand-written SQL mirroring what STD's compiler will generate (\`bench/src/compile.ts\`). Reproduce with \`pnpm bench\`.`,
    "",
    "## Decision",
    "",
    decisionSection(report),
    "",
    "## Reads (p50 / p95, milliseconds)",
    "",
    "Bold rows are decisive (defined by Contracts 2.6); the others are the restricted (or admin) variants, reported for information.",
    "",
    readsTable(report.runs),
    "",
    "## Writes",
    "",
    writesTable(report.runs),
    "",
    ...equivalenceSection(report),
    ...sections(
      "## Sizes (after load and VACUUM ANALYZE, before writes)",
      report.runs.map((run) => sizesSection(run))
    ),
    ...sections(
      "## Generation",
      report.runs.map((run) => generationSection(run))
    ),
    "## Environment",
    "",
    environmentSection(report),
    "",
    "## Definitions",
    "",
    definitionsSection(),
    "",
    "## Plans of the median runs",
    "",
    plansSection(report.runs),
  ].join("\n");
};

/**
 * Writes the Markdown and JSON files.
 *
 * @param report - The results.
 * @param options - Where to write (`--out`) and the file name's mode.
 * @returns The paths written.
 */
export const writeReport = (
  report: BenchReport,
  options: Options
): Effect.Effect<readonly string[], BenchError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new BenchError({ message: `cannot write results: ${String(cause)}` }),
    try: async () => {
      const directory = path.isAbsolute(options.out)
        ? options.out
        : path.join(packageDir, options.out);

      const base = path.join(
        directory,
        `${report.date.slice(0, 10)}-${fileName(options)}`
      );

      await mkdir(directory, { recursive: true });
      await writeFile(`${base}.md`, renderMarkdown(report));
      await writeFile(
        `${base}.json`,
        `${JSON.stringify(report, undefined, 2)}\n`
      );

      return [`${base}.md`, `${base}.json`];
    },
  });
