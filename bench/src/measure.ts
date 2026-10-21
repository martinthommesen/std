/**
 * Read measurement (Contracts 2.6 "Method"): per read, warm-up runs and
 * measured runs with seeded random parameters, run one at a time on one
 * connection, each inside a READ COMMITTED request transaction as STD runs
 * it; p50 and p95 over the measured runs, and `EXPLAIN (ANALYZE, BUFFERS)` of
 * the run closest to the median.
 */
import { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { BenchError } from "./errors.ts";
import { decodeRows, execute } from "./execute.ts";
import { makeRng } from "./random.ts";
import type { Compiled } from "./sql-text.ts";
import { medianIndex, percentile, round3 } from "./stats.ts";
import type { ModelContext, StorageModel } from "./storage-model.ts";
import type { ReadDef, ReadInstance, Samples } from "./workload.ts";
import { compileInstance } from "./workload.ts";

/**
 * Supplementary (non-decisive) reads get fewer runs: some, such as the
 * restricted Q2 count, take seconds at 10M records.
 */
const supplementaryWarmup = 5;
const supplementaryRuns = 30;

/** How many runs to make for each decisive read. */
export interface ReadConfig {
  readonly warmup: number;
  readonly runs: number;
  readonly seed: number;
}

/** One statement of the median run with its plan. */
export interface StatementPlan {
  readonly text: string;
  readonly params: readonly (string | null)[];
  readonly plan: string;
}

/** The measurement of one read. */
export interface ReadResult {
  readonly name: string;
  readonly query: ReadDef["query"];
  readonly caller: ReadDef["caller"];
  readonly endpoint: string;
  readonly description: string;
  readonly decisive: boolean;
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
  readonly meanRows: number;
  readonly medianRun: number;
  readonly plans: readonly StatementPlan[];
}

/** A read with the model it runs against. */
export interface ReadTarget {
  readonly model: StorageModel;
  readonly ctx: ModelContext;
  readonly samples: Samples;
}

/**
 * Draws the instances of a read; the same for every model.
 *
 * @param def - The read.
 * @param samples - Records and users to draw from.
 * @param seed - The run's seed.
 * @param count - How many instances.
 * @returns The instances.
 */
export const instancesOf = (
  def: ReadDef,
  samples: Samples,
  seed: number,
  count: number
): readonly ReadInstance[] => {
  const rng = makeRng(`${seed}:${def.name}`);

  return Array.from({ length: count }, () => def.instance(rng, samples));
};

/**
 * Runs the statements of one request in one transaction.
 *
 * @param statements - The request's statements.
 * @returns Each statement's undecoded rows.
 */
export const runRequest = (
  statements: readonly Compiled[]
): Effect.Effect<readonly (readonly unknown[])[], SqlError, PgClient> =>
  Effect.gen(function* runInTransaction() {
    const sql = yield* PgClient;

    return yield* sql.withTransaction(
      Effect.all(statements.map((statement) => execute(statement)))
    );
  });

const PlanRow = Schema.Struct({ "QUERY PLAN": Schema.String });

const explain = (
  statement: Compiled
): Effect.Effect<string, SqlError | BenchError, PgClient> =>
  Effect.gen(function* explainStatement() {
    const sql = yield* PgClient;

    const rows: readonly unknown[] = yield* sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${statement.text}`,
      statement.params
    ).unprepared;

    const lines = yield* decodeRows(PlanRow, rows);

    return lines.map((line) => line["QUERY PLAN"]).join("\n");
  });

const isSetting = (statement: Compiled): boolean =>
  statement.text.startsWith("SET ");

// Explains a request's statements in one transaction; `SET LOCAL` statements run, the others are explained.
const plansOf = (
  statements: readonly Compiled[]
): Effect.Effect<readonly StatementPlan[], SqlError | BenchError, PgClient> =>
  Effect.gen(function* explainRequest() {
    const sql = yield* PgClient;

    const explainAll = Effect.gen(function* explainInTransaction() {
      const plans: StatementPlan[] = [];

      for (const statement of statements) {
        if (isSetting(statement)) {
          yield* execute(statement);
        } else {
          plans.push({
            params: statement.params,
            plan: yield* explain(statement),
            text: statement.text,
          });
        }
      }

      return plans;
    });

    return yield* sql.withTransaction(explainAll);
  });

/** How a request is compiled, and which instances it draws. */
export interface ReadVariant {
  /** Compiles one instance; defaults to the plain form. */
  readonly compile?: (
    instance: ReadInstance
  ) => Effect.Effect<readonly Compiled[], SqlError | BenchError, PgClient>;
  /** Draw the instances of this read instead, so variants share parameters. */
  readonly seedName?: string;
}

/**
 * Measures one read against one model.
 *
 * @param target - The model, its context and the samples.
 * @param def - The read.
 * @param config - Warm-up runs, measured runs and seed.
 * @param variant - How to compile the request and which read's parameters to draw (defaults to the plain form).
 * @returns p50, p95 and the median run's plans.
 */
export const measureRead = (
  target: ReadTarget,
  def: ReadDef,
  config: ReadConfig,
  variant: ReadVariant = {}
): Effect.Effect<ReadResult, SqlError | BenchError, PgClient> =>
  Effect.gen(function* measureOneRead() {
    const compile =
      variant.compile ??
      ((instance: ReadInstance) =>
        compileInstance(target.model, target.ctx, instance));

    const warmup = def.decisive
      ? config.warmup
      : Math.min(config.warmup, supplementaryWarmup);

    const runs = def.decisive
      ? config.runs
      : Math.min(config.runs, supplementaryRuns);

    const instances = instancesOf(
      { ...def, name: variant.seedName ?? def.name },
      target.samples,
      config.seed,
      warmup + runs
    );

    const requests = yield* Effect.all(instances.map(compile));

    for (const request of requests.slice(0, warmup)) {
      yield* runRequest(request);
    }

    const timings: number[] = [];
    let rows = 0;

    for (const request of requests.slice(warmup)) {
      const begin = performance.now();
      const results = yield* runRequest(request);

      const page =
        results.find(
          (_rows, index) =>
            !isSetting(request[index] ?? { params: [], text: "" })
        ) ?? [];

      timings.push(performance.now() - begin);
      rows += page.length;
    }

    const median = medianIndex(timings);
    const medianRequest = requests[warmup + median] ?? [];
    const plans = yield* plansOf(medianRequest);

    return {
      caller: def.caller,
      decisive: def.decisive,
      description: def.description,
      endpoint: def.endpoint,
      max: round3(Math.max(...timings)),
      meanRows: round3(rows / Math.max(1, timings.length)),
      medianRun: median,
      min: round3(Math.min(...timings)),
      name: def.name,
      p50: round3(percentile(timings, 50)),
      p95: round3(percentile(timings, 95)),
      plans,
      query: def.query,
      runs: timings.length,
    };
  });
