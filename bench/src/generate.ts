/**
 * The set-based data generator: staging tables first (UUIDv7 IDs from
 * `uuidv7()`, classes, audit fields, owners, ticket targets), then each
 * model's tables from the staging tables with `INSERT ... SELECT` in parallel
 * chunks, then keys, foreign keys, indexes, triggers, `VACUUM (ANALYZE)` and a
 * checkpoint. Values are pure functions of the record number (seeded by
 * fixed per-field salts), so the data is the same in every run; only the
 * UUIDv7 IDs differ between databases.
 */
import { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { ServerConfig } from "./database.ts";
import { clientLayer } from "./database.ts";
import type { BenchError } from "./errors.ts";
import { query } from "./execute.ts";
import type { ClassName } from "./hierarchy.ts";
import { classDef } from "./hierarchy.ts";
import {
  auxSchema,
  baseSetup,
  ownerFieldOf,
  stageClassRecords,
  stageJobs,
  stageKeys,
  ticketStageJobs,
  ticketStageKeys,
  userTable,
} from "./models/common.ts";
import type {
  LoadChunks,
  ModelContext,
  StorageModel,
} from "./storage-model.ts";

/** One model to load into the database. */
export interface PlannedModel {
  readonly model: StorageModel;
  readonly ctx: ModelContext;
}

/** What to generate into one database. */
export interface GenerationPlan {
  readonly database: string;
  readonly records: number;
  readonly users: number;
  readonly tickets: number;
  readonly models: readonly PlannedModel[];
  /** Concurrent load statements. */
  readonly parallelism: number;
}

/** One timed generation step. */
export interface GenerationStep {
  readonly name: string;
  readonly seconds: number;
}

/** How long each generation step took. */
export interface GenerationReport {
  readonly steps: readonly GenerationStep[];
  readonly totalSeconds: number;
}

const indexConcurrency = 3;
const millisecondsPerSecond = 1000;
const chunksPerConnection = 2;
const markerTable = `${auxSchema}.generated`;

/**
 * Splits `1..total` into inclusive ranges.
 *
 * @param total - The last number.
 * @param parts - How many ranges at most.
 * @returns The ranges.
 */
export const chunkRanges = (
  total: number,
  parts: number
): readonly (readonly [number, number])[] => {
  const count = Math.max(1, Math.min(parts, total));
  const size = Math.ceil(total / count);
  const ranges: (readonly [number, number])[] = [];

  for (let index = 0; index < count; index += 1) {
    const low = index * size + 1;
    const high = Math.min(total, (index + 1) * size);

    if (low <= high) {
      ranges.push([low, high]);
    }
  }

  return ranges;
};

const generationSettings = {
  maintenance_work_mem: "2GB",
  synchronous_commit: "off",
  work_mem: "256MB",
};

interface Runner {
  readonly steps: GenerationStep[];
  readonly database: string;
}

const exec: (text: string) => Effect.Effect<void, SqlError, PgClient> =
  Effect.fn("bench.exec")(function* executeDdl(text: string) {
    const sql = yield* PgClient;

    yield* sql.unsafe(text).unprepared;
  });

const sequential = (
  texts: readonly string[]
): Effect.Effect<void, SqlError, PgClient> =>
  Effect.all(texts.map(exec), { discard: true });

const parallel = (
  texts: readonly string[],
  concurrency: number
): Effect.Effect<void, SqlError, PgClient> =>
  Effect.all(texts.map(exec), { concurrency, discard: true });

const step = <E>(
  runner: Runner,
  name: string,
  effect: Effect.Effect<void, E, PgClient>
): Effect.Effect<void, E, PgClient> =>
  Effect.gen(function* timedStep() {
    const begin = performance.now();

    yield* effect;

    const seconds = (performance.now() - begin) / millisecondsPerSecond;

    runner.steps.push({ name, seconds });
    yield* Effect.logInfo(
      `generate ${runner.database}: ${name} took ${seconds.toFixed(1)} s`
    );
  });

const generateModel = Effect.fn("bench.generateModel")(function* loadModel(
  runner: Runner,
  planned: PlannedModel,
  chunks: LoadChunks,
  parallelism: number
) {
  const { ctx, model } = planned;
  const first = runner.steps.length;
  const label = `${model.id} (${ctx.schema})`;
  const loads = model.loadJobs(ctx, chunks).map((job) => job.text);
  const vacuums = model.tables(ctx).map((name) => `VACUUM (ANALYZE) ${name}`);

  yield* step(
    runner,
    `${label}: create tables`,
    sequential(model.createTables(ctx))
  );
  yield* step(runner, `${label}: load`, parallel(loads, parallelism));
  yield* step(
    runner,
    `${label}: keys`,
    Effect.all(model.keys(ctx).map(sequential), {
      concurrency: parallelism,
      discard: true,
    })
  );
  yield* step(
    runner,
    `${label}: foreign keys`,
    sequential(model.foreignKeys(ctx))
  );
  yield* step(
    runner,
    `${label}: indexes`,
    parallel(model.indexes(ctx), indexConcurrency)
  );
  yield* step(runner, `${label}: triggers`, sequential(model.finish(ctx)));
  yield* step(
    runner,
    `${label}: vacuum analyze`,
    parallel(vacuums, parallelism)
  );

  const sql = yield* PgClient;

  yield* sql.unsafe(
    `INSERT INTO ${markerTable} (schema_name, model, records, mitigations, report, finished_at) ` +
      "VALUES ($1::text, $2::text, $3::bigint, $4::boolean, $5::jsonb, now())",
    [
      ctx.schema,
      model.id,
      String(ctx.records),
      String(ctx.mitigations),
      JSON.stringify(runner.steps.slice(first)),
    ]
  );
});

const generateAll: (
  plan: GenerationPlan
) => Effect.Effect<GenerationReport, SqlError, PgClient> = Effect.fn(
  "bench.generateAll"
)(function* generateDatabase(plan: GenerationPlan) {
  const runner: Runner = { database: plan.database, steps: [] };
  const started = performance.now();

  const chunks: LoadChunks = {
    records: chunkRanges(plan.records, plan.parallelism * chunksPerConnection),
    tickets: chunkRanges(plan.tickets, plan.parallelism * chunksPerConnection),
  };

  const [firstModel] = plan.models;

  if (firstModel === undefined) {
    return { steps: [], totalSeconds: 0 };
  }

  const { ctx } = firstModel;

  const stage = stageJobs(ctx, chunks, ownerFieldOf(classDef("item"))).map(
    (job) => job.text
  );

  const ticketStage = ticketStageJobs(ctx, chunks).map((job) => job.text);

  yield* step(
    runner,
    "users and staging tables",
    sequential(baseSetup(plan.users))
  );
  yield* step(runner, "stage records", parallel(stage, plan.parallelism));
  yield* step(
    runner,
    "stage keys",
    sequential([...stageKeys, `ANALYZE ${auxSchema}.stage`])
  );
  yield* step(runner, "stage tickets", parallel(ticketStage, plan.parallelism));
  yield* step(
    runner,
    "stage ticket keys",
    sequential([
      ...ticketStageKeys,
      `ANALYZE ${auxSchema}.ticket_stage`,
      `VACUUM (ANALYZE) ${userTable}`,
    ])
  );
  yield* exec(
    `CREATE TABLE IF NOT EXISTS ${markerTable} (schema_name text PRIMARY KEY, model text NOT NULL, ` +
      "records bigint NOT NULL, mitigations boolean NOT NULL, report jsonb, finished_at timestamptz NOT NULL)"
  );

  for (const planned of plan.models) {
    yield* generateModel(runner, planned, chunks, plan.parallelism);
  }

  yield* step(runner, "checkpoint", exec("CHECKPOINT"));

  return {
    steps: runner.steps,
    totalSeconds: (performance.now() - started) / millisecondsPerSecond,
  };
});

/**
 * Generates the plan into an existing, empty database.
 *
 * @param server - The bench server.
 * @param plan - Database, sizes and models.
 * @returns How long each step took.
 */
export const generate = (
  server: ServerConfig,
  plan: GenerationPlan
): Effect.Effect<GenerationReport, SqlError> =>
  generateAll(plan).pipe(
    Effect.provide(
      clientLayer(server, plan.database, {
        maxConnections: plan.parallelism,
        settings: generationSettings,
      })
    )
  );

const FoundRow = Schema.Struct({ found: Schema.Boolean });

const MarkerRow = Schema.Struct({
  mitigations: Schema.Boolean,
  model: Schema.String,
  records: Schema.String,
  schema_name: Schema.String,
});

/**
 * True when every planned model was fully generated into the database already.
 *
 * @param server - The bench server.
 * @param plan - Database, sizes and models.
 * @returns Whether the database can be reused.
 */
export const isGenerated: (
  server: ServerConfig,
  plan: GenerationPlan
) => Effect.Effect<boolean, SqlError | BenchError> = Effect.fn(
  "bench.isGenerated"
)(
  function* checkMarker(_server: ServerConfig, plan: GenerationPlan) {
    const [exists] = yield* query(
      {
        params: [markerTable],
        text: "SELECT to_regclass($1::text) IS NOT NULL AS found",
      },
      FoundRow
    );

    if (exists?.found !== true) {
      return false;
    }

    const rows = yield* query(
      {
        params: [],
        text: `SELECT schema_name, model, records::text AS records, mitigations FROM ${markerTable}`,
      },
      MarkerRow
    );

    return plan.models.every(({ model, ctx }) =>
      rows.some(
        (row) =>
          row.schema_name === ctx.schema &&
          row.model === model.id &&
          row.records === String(ctx.records) &&
          row.mitigations === ctx.mitigations
      )
    );
  },
  (effect, server, plan) =>
    effect.pipe(
      Effect.provide(clientLayer(server, plan.database, { maxConnections: 1 }))
    )
);

const disposableChunks = 8;
const disposableConcurrency = 4;

const MaxRow = Schema.Struct({ last: Schema.String });

const DisposableRow = Schema.Struct({
  id: Schema.String,
  owner: Schema.NullOr(Schema.String),
});

/** A disposable record: its ID and owner. */
export interface DisposableRecord {
  readonly id: string;
  readonly owner: string | null;
}

/**
 * Adds records of one class that nothing references, set-based, through the
 * staging table and the model's own load SQL: the delete targets of W3,
 * prepared before W3 so its phases do not depend on W1's throughput. Not
 * timed.
 *
 * @param model - The storage model.
 * @param ctx - Its schema and sizes.
 * @param cls - The class of the new records.
 * @param count - How many.
 * @returns The new records, in staging order.
 */
export const addDisposableRecords = Effect.fn("bench.addDisposableRecords")(
  function* addDisposable(
    model: StorageModel,
    ctx: ModelContext,
    cls: ClassName,
    count: number
  ) {
    const [max] = yield* query(
      {
        params: [],
        text: `SELECT COALESCE(max(n), 0)::text AS last FROM ${auxSchema}.stage`,
      },
      MaxRow
    );

    const first = Number(max?.last ?? "0") + 1;

    const ranges = chunkRanges(count, disposableChunks).map(
      ([low, high]) => [first + low - 1, first + high - 1] as const
    );

    const owner = ownerFieldOf(classDef("item"));

    yield* Effect.all(
      ranges.map((range) =>
        exec(stageClassRecords(ctx, range, owner, classDef(cls).id))
      ),
      { concurrency: disposableConcurrency, discard: true }
    );

    const loads = model
      .loadJobs(ctx, { records: ranges, tickets: [] })
      .map((job) => job.text);

    yield* Effect.all(loads.map(exec), {
      concurrency: disposableConcurrency,
      discard: true,
    });

    return yield* query(
      {
        params: [String(first)],
        text: `SELECT id::text AS id, owner::text AS owner FROM ${auxSchema}.stage WHERE n >= $1::bigint ORDER BY n`,
      },
      DisposableRow
    );
  }
);
