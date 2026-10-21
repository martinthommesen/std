/**
 * `pnpm bench --rewrites`: can STD's read compiler meet the Q6 and Q7
 * budgets on class-table storage? Measures the plain form of Q6 and Q7
 * against the branch form (`compileBranchedList`), which splits the row
 * rule's OR into disjoint UNION ALL branches that each use their own index,
 * after checking that both forms return the same rows. For Q7 it also
 * measures what the branch form would still need: no parallel workers for
 * the ordered ticket scan, custom plans instead of the generic plan of the
 * prepared statement, and a covering index for the item probe.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "effect";
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { Options } from "./cli.ts";
import { compileBranchedList } from "./compile.ts";
import type { ServerConfig } from "./database.ts";
import {
  clientLayer,
  command,
  dropDatabase,
  ensureServer,
  serverConfig,
} from "./database.ts";
import type { PostgresInfo } from "./environment.ts";
import { postgresInfo } from "./environment.ts";
import { checkBranchedEquivalence } from "./equivalence.ts";
import { BenchError } from "./errors.ts";
import { execute } from "./execute.ts";
import type { ReadResult, ReadVariant, StatementPlan } from "./measure.ts";
import { measureRead } from "./measure.ts";
import { prepareModel, samplesPerRun } from "./pipeline.ts";
import type { Compiled } from "./sql-text.ts";
import { q, table } from "./sql-text.ts";
import type { ModelContext, StorageModel } from "./storage-model.ts";
import type { ReadDef, ReadInstance, Samples } from "./workload.ts";
import { compileInstance, loadSamples, reads } from "./workload.ts";

const millisecondsPerSecond = 1000;
const equivalenceInstances = 20;
const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** The extra index the "what would be needed" variant measures. */
export const coveringIndexName = "item_rule_probe_idx";

const coveringIndex = (ctx: ModelContext): string =>
  `CREATE INDEX ${q(coveringIndexName)} ON ${table(ctx.schema, "item")} (id) INCLUDE (status, owner, location, priority, class_id)`;

const noParallelWorkers: Compiled = {
  params: [],
  text: "SET LOCAL max_parallel_workers_per_gather = 0",
};

interface Variant {
  readonly name: string;
  readonly read: string;
  readonly form: string;
  readonly variant: (model: StorageModel, ctx: ModelContext) => ReadVariant;
}

const branched =
  (prefix: readonly Compiled[]) =>
  (model: StorageModel, ctx: ModelContext): ReadVariant => ({
    compile: (instance: ReadInstance) =>
      instance.kind === "list" && instance.depth === 0
        ? Effect.succeed([
            ...prefix,
            compileBranchedList(
              { caller: instance.caller, ctx, model },
              instance.query
            ),
          ])
        : compileInstance(model, ctx, instance),
  });

const plain = (): ReadVariant => ({});

const customPlans: Compiled = {
  params: [],
  text: "SET LOCAL plan_cache_mode = force_custom_plan",
};

const beforeIndex: readonly Variant[] = [
  {
    form: "plain (as in the Stage 0 run)",
    name: "Q6",
    read: "Q6",
    variant: plain,
  },
  {
    form: "branch form",
    name: "Q6 branched",
    read: "Q6",
    variant: branched([]),
  },
  {
    form: "plain (as in the Stage 0 run)",
    name: "Q7",
    read: "Q7",
    variant: plain,
  },
  {
    form: "branch form",
    name: "Q7 branched",
    read: "Q7",
    variant: branched([]),
  },
  {
    form: "branch form, `SET LOCAL max_parallel_workers_per_gather = 0`",
    name: "Q7 branched, serial",
    read: "Q7",
    variant: branched([noParallelWorkers]),
  },
  {
    form: "branch form, serial, `SET LOCAL plan_cache_mode = force_custom_plan`",
    name: "Q7 branched, serial, custom plans",
    read: "Q7",
    variant: branched([noParallelWorkers, customPlans]),
  },
];

const afterIndex: readonly Variant[] = [
  {
    form: `branch form, serial, with \`${coveringIndexName}\``,
    name: "Q7 branched, serial, covering index",
    read: "Q7",
    variant: branched([noParallelWorkers]),
  },
  {
    form: `branch form, serial, custom plans, with \`${coveringIndexName}\``,
    name: "Q7 branched, serial, custom plans, covering index",
    read: "Q7",
    variant: branched([noParallelWorkers, customPlans]),
  },
];

const readDef = (name: string): ReadDef => {
  const found = reads.find((def) => def.name === name);

  if (found === undefined) {
    throw new Error(`unknown read ${name}`);
  }

  return found;
};

/** One measured variant. */
export interface VariantResult extends ReadResult {
  readonly variant: string;
  readonly form: string;
}

const measureVariants = (
  model: StorageModel,
  ctx: ModelContext,
  samples: Samples,
  options: Options,
  variants: readonly Variant[]
) =>
  Effect.all(
    variants.map((entry) =>
      Effect.gen(function* measureVariant() {
        const def = readDef(entry.read);

        const result = yield* measureRead(
          { ctx, model, samples },
          def,
          options,
          { ...entry.variant(model, ctx), seedName: def.name }
        );

        yield* Effect.logInfo(
          `${entry.name}: p50 ${result.p50} ms, p95 ${result.p95} ms`
        );

        return {
          ...result,
          form: entry.form,
          name: entry.name,
          variant: entry.name,
        };
      })
    )
  );

/** The results of a rewrites run. */
export interface RewritesReport {
  readonly date: string;
  readonly commit: string;
  readonly command: string;
  readonly database: string;
  readonly records: number;
  readonly seed: number;
  readonly runs: number;
  readonly warmup: number;
  readonly equivalence: readonly string[];
  readonly variants: readonly VariantResult[];
  readonly postgres: PostgresInfo;
  readonly totalSeconds: number;
}

const planText = (plan: StatementPlan): string =>
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

const variantPlans = (result: VariantResult): string =>
  [
    `### ${result.variant}: p50 ${result.p50} ms, p95 ${result.p95} ms`,
    "",
    ...result.plans.map((plan) => planText(plan)),
  ].join("\n");

/**
 * Renders the rewrites results as Markdown.
 *
 * @param report - The results.
 * @returns The Markdown text.
 */
export const renderRewrites = (report: RewritesReport): string => {
  const rows = report.variants.map(
    (result) =>
      `| ${result.variant} | ${result.form} | ${result.p50} | ${result.p95} | ${result.max} | ${result.meanRows} |`
  );

  return [
    "# STD Stage 0 follow-up: Q6 and Q7 in the branch form",
    "",
    `Date ${report.date}, commit \`${report.commit}\`, command \`${report.command}\`, class-table at ${report.records} records (${report.database}), seed ${report.seed}, ${report.warmup} warm-up and ${report.runs} measured runs per variant, every variant on the same parameters. Total time ${(report.totalSeconds / 60).toFixed(1)} min. ${report.postgres.version}.`,
    "",
    "| Variant | Form | p50 ms | p95 ms | max ms | rows |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Equivalence (branch form against plain form, same rows in the same order): ${report.equivalence.join("; ")}.`,
    "",
    "## Plans of the median runs",
    "",
    ...report.variants.map((result) => variantPlans(result)),
  ].join("\n");
};

const writeRewrites = (
  report: RewritesReport,
  options: Options
): Effect.Effect<readonly string[], BenchError> =>
  Effect.tryPromise({
    catch: (cause) =>
      new BenchError({ message: `cannot write results: ${String(cause)}` }),
    try: async () => {
      const directory = path.isAbsolute(options.out)
        ? options.out
        : path.join(packageDir, options.out);

      const base = path.join(directory, `${report.date.slice(0, 10)}-rewrites`);

      await mkdir(directory, { recursive: true });
      await writeFile(`${base}.md`, renderRewrites(report));
      await writeFile(
        `${base}.json`,
        `${JSON.stringify(report, undefined, 2)}\n`
      );

      return [`${base}.md`, `${base}.json`];
    },
  });

const measureAll = (model: StorageModel, ctx: ModelContext, options: Options) =>
  Effect.gen(function* measureRewrites() {
    const samples = yield* loadSamples(options.seed, samplesPerRun);

    const equivalence = yield* checkBranchedEquivalence(
      model,
      ctx,
      samples,
      options.seed,
      equivalenceInstances
    );

    yield* Effect.logInfo(
      `branch form agrees with plain form: ${equivalence.join("; ")}`
    );

    const first = yield* measureVariants(
      model,
      ctx,
      samples,
      options,
      beforeIndex
    );

    yield* execute({ params: [], text: coveringIndex(ctx) });
    yield* execute({
      params: [],
      text: `VACUUM (ANALYZE) ${table(ctx.schema, "item")}`,
    });

    const second = yield* measureVariants(
      model,
      ctx,
      samples,
      options,
      afterIndex
    );

    yield* execute({
      params: [],
      text: `DROP INDEX ${table(ctx.schema, coveringIndexName)}`,
    });

    return { equivalence, variants: [...first, ...second] };
  });

const gitCommit: Effect.Effect<string> = command("git", [
  "rev-parse",
  "--short",
  "HEAD",
]).pipe(
  Effect.map((output) => output.trim()),
  Effect.orElseSucceed(() => "unknown")
);

/**
 * Runs the rewrites measurement on class-table storage and writes
 * `results/<date>-rewrites.md` and `.json`.
 *
 * @param options - Parsed options (`--scale`, default 10m; `--reuse`; `--keep`).
 * @param commandLine - The command as typed.
 * @returns The files written.
 */
export const runRewrites: (
  options: Options,
  commandLine: string
) => Effect.Effect<
  readonly string[],
  SqlError | BenchError | Config.ConfigError
> = Effect.fn("bench.runRewrites")(function* rewrites(
  options: Options,
  commandLine: string
) {
  const begin = performance.now();
  const server: ServerConfig = yield* serverConfig;

  yield* ensureServer(server);

  const [scale] = options.scales;

  if (scale === undefined) {
    return yield* new BenchError({ message: "--rewrites needs a scale" });
  }

  const prepared = yield* prepareModel(server, options, {
    mitigations: false,
    model: "class-table",
    scale,
  });

  const layer = clientLayer(server, prepared.database, { maxConnections: 2 });

  const measured = yield* measureAll(
    prepared.model,
    prepared.ctx,
    options
  ).pipe(Effect.provide(layer));

  const postgres = yield* postgresInfo.pipe(Effect.provide(layer));

  if (!options.keep) {
    yield* dropDatabase(server, prepared.database);
  }

  const report: RewritesReport = {
    ...measured,
    command: commandLine,
    commit: yield* gitCommit,
    database: prepared.database,
    date: new Date().toISOString(),
    postgres,
    records: scale.records,
    runs: options.runs,
    seed: options.seed,
    totalSeconds: (performance.now() - begin) / millisecondsPerSecond,
    warmup: options.warmup,
  };

  return yield* writeRewrites(report, options);
});
