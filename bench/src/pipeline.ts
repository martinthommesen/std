/**
 * Orchestrates a benchmark: bring up the bench server, generate each run's
 * database, measure reads, sizes and writes, apply the decision rule (and the
 * follow-ups it asks for), and write the results files.
 */
import type { PgClient } from "@effect/sql-pg/PgClient";
import type { DatabaseTlsError } from "@std/postgres/transport";
import type { Config } from "effect";
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { Options } from "./cli.ts";
import { parseScale } from "./cli.ts";
import type { ServerConfig } from "./database.ts";
import {
  clientLayer,
  command,
  databaseExists,
  dropDatabase,
  ensureServer,
  recreateDatabase,
  serverConfig,
} from "./database.ts";
import {
  decide,
  explainStep,
  fallbackDecision,
  summarize,
} from "./decision.ts";
import type { LoadWindow } from "./environment.ts";
import { hostInfo, postgresInfo, withLoadWindow } from "./environment.ts";
import { checkBranchedEquivalence, checkEquivalence } from "./equivalence.ts";
import type { BenchError } from "./errors.ts";
import type {
  GenerationPlan,
  GenerationReport,
  PlannedModel,
} from "./generate.ts";
import { generate, isGenerated } from "./generate.ts";
import { ticketRatio } from "./hierarchy.ts";
import type { ReadResult } from "./measure.ts";
import { measureRead } from "./measure.ts";
import { modelById } from "./models/registry.ts";
import { writeReport } from "./report.ts";
import type { BenchReport, Decision, ModelRun, Scale } from "./results.ts";
import type { TableSize } from "./sizes.ts";
import { schemaSizes } from "./sizes.ts";
import type { ModelContext, ModelId, StorageModel } from "./storage-model.ts";
import { modelIds } from "./storage-model.ts";
import type { Samples } from "./workload.ts";
import { loadSamples, reads } from "./workload.ts";
import type { WriteResult } from "./writes.ts";
import { measureWrites } from "./writes.ts";

const sampleCount = 5000;
const smokeBranchInstances = 25;
const loadParallelism = 6;
const millisecondsPerSecond = 1000;
const classTable: ModelId = "class-table";
const tenMillion = "10m";
const invalidMeasurement = "invalid-measurement";

type PipelineError =
  | SqlError
  | BenchError
  | Config.ConfigError
  | DatabaseTlsError;

const contextFor = (
  scale: Scale,
  schema: string,
  mitigations: boolean
): ModelContext => ({
  mitigations,
  records: scale.records,
  schema,
  tickets: Math.round(scale.records * ticketRatio),
  users: scale.users,
});

const runLabel = (
  model: ModelId,
  scale: Scale,
  mitigations: boolean
): string => {
  const suffix = mitigations ? " + class_id indexes" : "";

  return `${model}${suffix} @ ${scale.label}`;
};

const databaseFor = (
  model: ModelId,
  scale: Scale,
  mitigations: boolean
): string => {
  const suffix = mitigations ? "_mit" : "";

  return `bench_${model.replaceAll("-", "_")}_${scale.label}${suffix}`;
};

const planFor = (
  database: string,
  scale: Scale,
  models: readonly PlannedModel[]
): GenerationPlan => ({
  database,
  models,
  parallelism: loadParallelism,
  records: scale.records,
  tickets: Math.round(scale.records * ticketRatio),
  users: scale.users,
});

const prepareDatabase: (
  server: ServerConfig,
  plan: GenerationPlan,
  reuse: boolean
) => Effect.Effect<GenerationReport, PipelineError> = Effect.fn(
  "bench.prepareDatabase"
)(function* prepare(
  server: ServerConfig,
  plan: GenerationPlan,
  reuse: boolean
) {
  const reusable =
    reuse &&
    (yield* databaseExists(server, plan.database)) &&
    (yield* isGenerated(server, plan));

  if (reusable) {
    yield* Effect.logInfo(`reusing ${plan.database}`);

    return { steps: [], totalSeconds: 0 };
  }

  yield* recreateDatabase(server, plan.database);

  return yield* generate(server, plan);
});

interface Measured {
  readonly reads: readonly ReadResult[];
  readonly writes: readonly WriteResult[];
  readonly sizes: readonly TableSize[];
  readonly load: readonly LoadWindow[];
}

const measureOne =
  (
    model: StorageModel,
    ctx: ModelContext,
    samples: Samples,
    options: Options
  ) =>
  (def: (typeof reads)[number]) =>
    Effect.tap(
      measureRead({ ctx, model, samples }, def, {
        ...options,
        // runModel and runSmoke allocate this pool for reads and writes.
        setupConcurrency: options.clients + 2,
      }),
      (result) =>
        Effect.logInfo(
          `${model.id} @ ${ctx.records}: ${result.name} p50 ${result.p50} ms, p95 ${result.p95} ms`
        )
    );

const measureModel: (
  model: StorageModel,
  ctx: ModelContext,
  samples: Samples,
  options: Options
) => Effect.Effect<Measured, PipelineError, PgClient> = Effect.fn(
  "bench.measureModel"
)(function* measureEverything(
  model: StorageModel,
  ctx: ModelContext,
  samples: Samples,
  options: Options
) {
  const allReads = Effect.all(
    reads.map(measureOne(model, ctx, samples, options))
  );

  const [readResults, readLoad] = yield* withLoadWindow(
    `${model.id} reads`,
    allReads
  );

  const sizes = yield* schemaSizes(ctx.schema);

  if (!options.writes) {
    return { load: [readLoad], reads: readResults, sizes, writes: [] };
  }

  const writeConfig = {
    clients: options.clients,
    seconds: options.writeSeconds,
    seed: options.seed,
  };

  const [writeResults, writeLoad] = yield* withLoadWindow(
    `${model.id} writes`,
    measureWrites(model, ctx, samples, writeConfig)
  );

  return {
    load: [readLoad, writeLoad],
    reads: readResults,
    sizes,
    writes: writeResults,
  };
});

/** One model at one scale. */
export interface RunSpec {
  readonly model: ModelId;
  readonly scale: Scale;
  readonly mitigations: boolean;
}

/** A generated database for one model. */
export interface PreparedModel {
  readonly database: string;
  readonly ctx: ModelContext;
  readonly model: StorageModel;
  readonly generation: GenerationReport;
}

/**
 * Generates (or, with `--reuse`, reuses) the database of one model at one scale.
 *
 * @param server - The bench server.
 * @param options - Parsed options (`--reuse`).
 * @param spec - Model, scale and mitigations.
 * @returns The database, its context and the generation times.
 */
export const prepareModel: (
  server: ServerConfig,
  options: Options,
  spec: RunSpec
) => Effect.Effect<PreparedModel, PipelineError> = Effect.fn(
  "bench.prepareModel"
)(function* prepareOneModel(
  server: ServerConfig,
  options: Options,
  spec: RunSpec
) {
  const model = modelById(spec.model);
  const database = databaseFor(spec.model, spec.scale, spec.mitigations);
  const ctx = contextFor(spec.scale, "bench", spec.mitigations);

  const generation = yield* prepareDatabase(
    server,
    planFor(database, spec.scale, [{ ctx, model }]),
    options.reuse
  );

  return { ctx, database, generation, model };
});

/** Parameter samples drawn per run. */
export const samplesPerRun = sampleCount;

const runModel: (
  server: ServerConfig,
  options: Options,
  spec: RunSpec
) => Effect.Effect<ModelRun, PipelineError> = Effect.fn("bench.runModel")(
  function* runOneModel(server: ServerConfig, options: Options, spec: RunSpec) {
    const startedAt = new Date().toISOString();
    const begin = performance.now();
    const label = runLabel(spec.model, spec.scale, spec.mitigations);

    yield* Effect.logInfo(
      `run ${label} in ${databaseFor(spec.model, spec.scale, spec.mitigations)}`
    );

    const { model, database, ctx, generation } = yield* prepareModel(
      server,
      options,
      spec
    );

    const measured = yield* Effect.flatMap(
      loadSamples(options.seed, sampleCount, options.clients + 2),
      (samples) => measureModel(model, ctx, samples, options)
    ).pipe(
      Effect.provide(
        clientLayer(server, database, { maxConnections: options.clients + 2 })
      )
    );

    if (!options.keep) {
      yield* dropDatabase(server, database);
    }

    const seconds = (performance.now() - begin) / millisecondsPerSecond;

    return {
      ...measured,
      database,
      generation,
      label,
      mitigations: spec.mitigations,
      model: spec.model,
      scale: spec.scale,
      seconds,
      startedAt,
    };
  }
);

interface Outcome {
  readonly runs: readonly ModelRun[];
  readonly decision: Decision | null;
  readonly equivalence: readonly string[] | null;
}

interface SmokeContext {
  readonly planned: readonly PlannedModel[];
  readonly generation: GenerationReport;
  readonly options: Options;
  readonly database: string;
  readonly scale: Scale;
}

const smokeRuns: (
  smoke: SmokeContext
) => Effect.Effect<Outcome, PipelineError, PgClient> = Effect.fn(
  "bench.smokeRuns"
)(function* measureSmoke(smoke: SmokeContext) {
  const { generation, options, planned } = smoke;

  const samples = yield* loadSamples(
    options.seed,
    sampleCount,
    options.clients + 2
  );

  const crossModel = yield* checkEquivalence(planned, samples, options.seed);

  const equivalence = [...crossModel];

  for (const { ctx, model } of planned) {
    const lines = yield* checkBranchedEquivalence(
      model,
      ctx,
      samples,
      options.seed,
      smokeBranchInstances
    );

    for (const line of lines) {
      equivalence.push(`${model.id} branch form, ${line}`);
    }
  }

  yield* Effect.logInfo(
    `equivalence: ${equivalence.length} requests agree across ${planned.length} models`
  );

  const runs: ModelRun[] = [];

  for (const { model, ctx } of planned) {
    const begin = performance.now();
    const measured = yield* measureModel(model, ctx, samples, options);

    runs.push({
      ...measured,
      database: smoke.database,
      generation: {
        steps: generation.steps.filter((entry) =>
          entry.name.startsWith(model.id)
        ),
        totalSeconds: generation.totalSeconds,
      },
      label: runLabel(model.id, smoke.scale, options.mitigations),
      mitigations: options.mitigations,
      model: model.id,
      scale: smoke.scale,
      seconds: (performance.now() - begin) / millisecondsPerSecond,
      startedAt: new Date().toISOString(),
    });
  }

  return { decision: null, equivalence, runs };
});

// Smoke mode: every model in one database with shared staging tables,
// checked for equivalence, then measured briefly.
const runSmoke: (
  server: ServerConfig,
  options: Options
) => Effect.Effect<Outcome, PipelineError> = Effect.fn("bench.runSmoke")(
  function* smoke(server: ServerConfig, options: Options) {
    const scale = options.scales[0] ?? parseScale("50k");
    const database = options.database ?? "bench_smoke";

    const planned = modelIds.map((id) => ({
      ctx: contextFor(
        scale,
        `bench_${id.replaceAll("-", "_")}`,
        options.mitigations
      ),
      model: modelById(id),
    }));

    const generation = yield* prepareDatabase(
      server,
      planFor(database, scale, planned),
      options.reuse
    );

    const result = yield* smokeRuns({
      database,
      generation,
      options,
      planned,
      scale,
    }).pipe(
      Effect.provide(
        clientLayer(server, database, { maxConnections: options.clients + 2 })
      )
    );

    if (!options.keep) {
      yield* dropDatabase(server, database);
    }

    return result;
  }
);

const runner =
  (server: ServerConfig, options: Options) =>
  (
    model: ModelId,
    scale: Scale,
    mitigations: boolean
  ): Effect.Effect<ModelRun, PipelineError> =>
    runModel(server, options, { mitigations, model, scale });

// The Stage 0 run: the three required runs, then whatever the decision rule asks for.
const runStage0: (
  server: ServerConfig,
  options: Options
) => Effect.Effect<Outcome, PipelineError> = Effect.fn("bench.runStage0")(
  function* stage0(server: ServerConfig, options: Options) {
    const run = runner(server, options);
    const large = parseScale(tenMillion);
    const oneMillionRun = yield* run(classTable, parseScale("1m"), false);
    const classTableRun = yield* run(classTable, large, false);
    const baselineRun = yield* run("single-table", large, false);
    const runs = [oneMillionRun, classTableRun, baselineRun];
    const first = decide(classTableRun, baselineRun, options.writeSeconds);

    if (first.problems.length > 0) {
      return {
        decision: summarize(invalidMeasurement, [first]),
        equivalence: null,
        runs,
      };
    }

    if (first.keep) {
      return {
        decision: summarize("keep-class-table", [first]),
        equivalence: null,
        runs,
      };
    }

    yield* Effect.logInfo(
      `decision rule not met (${explainStep(first)}); trying the class_id index mitigations`
    );

    const mitigatedRun = yield* run(classTable, large, true);
    const second = decide(mitigatedRun, baselineRun, options.writeSeconds);

    if (second.problems.length > 0) {
      return {
        decision: summarize(invalidMeasurement, [first, second]),
        equivalence: null,
        runs: [...runs, mitigatedRun],
      };
    }

    if (second.keep) {
      return {
        decision: summarize("keep-class-table-with-mitigations", [
          first,
          second,
        ]),
        equivalence: null,
        runs: [...runs, mitigatedRun],
      };
    }

    yield* Effect.logInfo(
      "decision rule still not met; benchmarking the partitioned and per-concrete-class models"
    );

    const partitionedRun = yield* run("partitioned", large, false);
    const concreteRun = yield* run("concrete-table", large, false);

    return {
      decision: fallbackDecision(
        [first, second],
        [partitionedRun, concreteRun],
        options.writeSeconds
      ),
      equivalence: null,
      runs: [...runs, mitigatedRun, partitionedRun, concreteRun],
    };
  }
);

const customDecision = (
  runs: readonly ModelRun[],
  mitigations: boolean,
  writeSeconds: number
): Decision | null => {
  const at10m = (
    model: ModelId,
    withMitigations: boolean
  ): ModelRun | undefined =>
    runs.find(
      (entry) =>
        entry.model === model &&
        entry.scale.label === tenMillion &&
        entry.mitigations === withMitigations
    );

  const classTableRun = at10m(classTable, mitigations);
  const baselineRun = at10m("single-table", false);

  if (classTableRun === undefined || baselineRun === undefined) {
    return null;
  }

  const step = decide(classTableRun, baselineRun, writeSeconds);

  if (step.problems.length > 0) {
    return summarize(invalidMeasurement, [step]);
  }

  return summarize(step.keep ? "keep-class-table" : "reopen", [step]);
};

const runCustom: (
  server: ServerConfig,
  options: Options
) => Effect.Effect<Outcome, PipelineError> = Effect.fn("bench.runCustom")(
  function* custom(server: ServerConfig, options: Options) {
    const runs: ModelRun[] = [];

    for (const scale of options.scales) {
      for (const model of options.models) {
        runs.push(
          yield* runModel(server, options, {
            mitigations: options.mitigations && model === classTable,
            model,
            scale,
          })
        );
      }
    }

    return {
      decision: customDecision(runs, options.mitigations, options.writeSeconds),
      equivalence: null,
      runs,
    };
  }
);

export const gitCommit: Effect.Effect<string> = command("git", [
  "rev-parse",
  "--short",
  "HEAD",
]).pipe(
  Effect.map((output) => output.trim()),
  Effect.orElseSucceed(() => "unknown")
);

const runMode = (
  server: ServerConfig,
  options: Options
): Effect.Effect<Outcome, PipelineError> => {
  if (options.mode === "smoke") {
    return runSmoke(server, options);
  }

  return options.mode === "stage0"
    ? runStage0(server, options)
    : runCustom(server, options);
};

/** The report and the files it was written to. */
export interface BenchmarkOutput {
  readonly report: BenchReport;
  readonly files: readonly string[];
}

/**
 * Runs the benchmark described by the options and writes its results files.
 *
 * @param options - Parsed command-line options.
 * @param commandLine - The command as typed, for the report.
 * @returns The report and the paths of the Markdown and JSON files.
 */
export const runBenchmark: (
  options: Options,
  commandLine: string
) => Effect.Effect<BenchmarkOutput, PipelineError | Config.ConfigError> =
  Effect.fn("bench.runBenchmark")(function* benchmark(
    options: Options,
    commandLine: string
  ) {
    const begin = performance.now();
    const server = yield* serverConfig;

    yield* ensureServer(server);

    const host = yield* hostInfo;

    const postgres = yield* postgresInfo.pipe(
      Effect.provide(
        clientLayer(server, server.adminDatabase, { maxConnections: 1 })
      )
    );

    const commit = yield* gitCommit;
    const { decision, equivalence, runs } = yield* runMode(server, options);

    const report: BenchReport = {
      command: commandLine,
      commit,
      date: new Date().toISOString(),
      decision,
      equivalence,
      host,
      method: {
        runs: options.runs,
        warmup: options.warmup,
        writeClients: options.clients,
        writeSeconds: options.writeSeconds,
      },
      postgres,
      runs,
      seed: options.seed,
      title:
        options.mode === "stage0"
          ? "Stage 0 inheritance benchmark"
          : `Inheritance benchmark (${options.mode})`,
      totalSeconds: (performance.now() - begin) / millisecondsPerSecond,
    };

    const files = yield* writeReport(report, options);

    return { files, report };
  });
