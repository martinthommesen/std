/**
 * Read measurement (Contracts 2.6 "Method"): per read, warm-up runs and
 * measured runs with seeded random parameters, run one at a time on one
 * connection, each inside a READ COMMITTED request transaction as STD runs
 * it; p50 and p95 over the measured runs, and `EXPLAIN (ANALYZE, BUFFERS)` of
 * the run closest to the median.
 */
import { PgClient } from "@effect/sql-pg/PgClient";
import { Array as EffectArray, Effect, Schema } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import type { BenchError } from "./errors.ts";
import { decodeRows, execute } from "./execute.ts";
import { makeRng } from "./random.ts";
import type { Compiled } from "./sql-text.ts";
import { medianIndex, percentile, round3 } from "./stats.ts";
import type { ModelContext, StorageModel } from "./storage-model.ts";
import type {
  CompiledRequest,
  ReadDef,
  ReadInstance,
  Samples,
} from "./workload.ts";
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
  /** Matches the caller's SQL connection-pool capacity for unmeasured setup. */
  readonly setupConcurrency: number;
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
 * @param request - The settings, page and optional count statements.
 * @returns The page and count rows.
 */
export const runRequest: (
  request: CompiledRequest
) => Effect.Effect<
  { readonly page: readonly unknown[]; readonly count: readonly unknown[] },
  SqlError,
  PgClient
> = Effect.fnUntraced(function* runInTransaction(request: CompiledRequest) {
  const sql = yield* PgClient;

  return yield* sql.withTransaction(
    Effect.gen(function* executeRequestStatements() {
      for (const setting of request.settings) {
        yield* execute(setting);
      }

      const page = yield* execute(request.page);

      const count =
        request.count === undefined ? [] : yield* execute(request.count);

      return { count, page };
    })
  );
});

const PlanRow = Schema.Struct({ "QUERY PLAN": Schema.String });

const literal = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

/**
 * The statements of one read, prepared with SQL `PREPARE` on one reserved
 * connection, so every measured run and the reported plan go through the
 * same prepared statement and its plan cache (custom or generic plan, as
 * Postgres chooses after five executions), as STD's prepared statements do.
 */
interface PreparedSession {
  readonly connection: Connection;
  readonly names: Map<string, string>;
  readonly prefix: string;
}

const keepRows = <A extends object>(rows: readonly A[]): readonly A[] => rows;

const run = (
  session: PreparedSession,
  text: string
): Effect.Effect<readonly unknown[], SqlError> =>
  session.connection.executeUnprepared(text, [], keepRows);

const executeText = Effect.fnUntraced(function* executeText(
  session: PreparedSession,
  statement: Compiled
) {
  let name = session.names.get(statement.text);

  if (name === undefined) {
    name = `${session.prefix}_${session.names.size}`;
    yield* run(session, `PREPARE ${name} AS ${statement.text}`);
    session.names.set(statement.text, name);
  }

  const args =
    statement.params.length === 0
      ? ""
      : `(${statement.params.map((value) => literal(value)).join(", ")})`;

  return `EXECUTE ${name}${args}`;
});

// Runs one request in a transaction on the session's connection; returns the page rows.
const runPrepared = Effect.fnUntraced(function* runPrepared(
  session: PreparedSession,
  request: CompiledRequest
) {
  const pageText = yield* executeText(session, request.page);

  const countText =
    request.count === undefined
      ? undefined
      : yield* executeText(session, request.count);

  yield* run(session, "BEGIN");

  for (const setting of request.settings) {
    yield* run(session, setting.text);
  }

  const page = yield* run(session, pageText);

  if (countText !== undefined) {
    yield* run(session, countText);
  }

  yield* run(session, "COMMIT");

  return page;
});

// EXPLAIN (ANALYZE, BUFFERS) EXECUTE of the same prepared statements, in one transaction on the same connection.
const plansOf = Effect.fnUntraced(function* explainRequest(
  session: PreparedSession,
  request: CompiledRequest
) {
  const plans: StatementPlan[] = [];

  yield* run(session, "BEGIN");

  for (const setting of request.settings) {
    yield* run(session, setting.text);
  }

  const statements =
    request.count === undefined
      ? [request.page]
      : [request.page, request.count];

  for (const statement of statements) {
    const text = yield* executeText(session, statement);

    const lines = yield* decodeRows(
      PlanRow,
      yield* run(session, `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${text}`)
    );

    plans.push({
      params: statement.params,
      plan: lines.map((line) => line["QUERY PLAN"]).join("\n"),
      text: statement.text,
    });
  }

  yield* run(session, "COMMIT");

  return plans;
});

const openSession = Effect.fnUntraced(function* openSession(prefix: string) {
  const sql = yield* PgClient;
  const connection = yield* sql.reserve;
  const session: PreparedSession = { connection, names: new Map(), prefix };

  // Runs before the reserved connection goes back to the pool.
  yield* Effect.addFinalizer(() =>
    Effect.ignore(
      Effect.all(
        [...session.names.values()].map((name) =>
          run(session, `DEALLOCATE ${name}`)
        )
      )
    )
  );

  return session;
});

/** How a request variant is compiled. */
export interface ReadVariant {
  /** Compiles one instance; defaults to the plain form. */
  readonly compile?: (
    instance: ReadInstance
  ) => Effect.Effect<CompiledRequest, SqlError | BenchError, PgClient>;
}

let sessionCounter = 0;

/**
 * Measures one read against one model: warm-up and measured runs through
 * prepared statements on one reserved connection, then
 * `EXPLAIN (ANALYZE, BUFFERS) EXECUTE` of the median run's parameters on the
 * same prepared statements.
 *
 * @param target - The model, its context and the samples.
 * @param def - The read.
 * @param config - Warm-up runs, measured runs and seed.
 * @param variant - How to compile the request (defaults to the plain form).
 * @returns p50, p95 and the median run's plans.
 */
export const measureRead = Effect.fn("bench.measureRead")(
  function* measureOneRead(
    target: ReadTarget,
    def: ReadDef,
    config: ReadConfig,
    variant: ReadVariant = {}
  ) {
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
      def,
      target.samples,
      config.seed,
      warmup + runs
    );

    const groups = EffectArray.groupBy(
      instances.map((instance, index) => ({ index, instance })),
      ({ index, instance }) =>
        variant.compile === undefined ? JSON.stringify(instance) : String(index)
    );

    // Setup probes use only the pool capacity already budgeted by the caller.
    const compiled = yield* Effect.all(
      Object.values(groups).map((group) =>
        Effect.map(compile(group[0].instance), (request) =>
          group.map(({ index }) => ({ index, request }))
        )
      ),
      { concurrency: config.setupConcurrency }
    );

    const requests = compiled
      .flat()
      .toSorted((left, right) => left.index - right.index)
      .map(({ request }) => request);

    sessionCounter += 1;

    return yield* Effect.scoped(
      Effect.gen(function* measureOnConnection() {
        const session = yield* openSession(`bench_read_${sessionCounter}`);

        for (const request of requests.slice(0, warmup)) {
          yield* runPrepared(session, request);
        }

        const timings: number[] = [];
        let rows = 0;

        for (const request of requests.slice(warmup)) {
          const begin = performance.now();
          const page = yield* runPrepared(session, request);

          timings.push(performance.now() - begin);
          rows += page.length;
        }

        const median = medianIndex(timings);
        const medianRequest = requests[warmup + median];

        const plans =
          medianRequest === undefined
            ? []
            : yield* plansOf(session, medianRequest);

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
        } satisfies ReadResult;
      })
    );
  }
);
