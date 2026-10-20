/**
 * Probe 6 (plan 0F; Contracts 4.1 step 11): write throughput of small save
 * transactions at 16 clients, with and without an in-transaction `NOTIFY`.
 *
 * Each save is a request transaction shaped like the record service's:
 * `begin_request()`, lock the root row alone (`FOR NO KEY UPDATE`), bump
 * its version with a version check, insert a change entry. The `notify`
 * variant adds `pg_notify('std_worker', <id>)` inside the transaction; the
 * other registers the worker wake-up after commit (`wakeWorkerAfterCommit`,
 * debounced to one `NOTIFY` per 250 ms per process), as STD does. A
 * listener on `std_worker` drains the notifications in both variants.
 *
 * The runs alternate (`after-commit`, `in-transaction`, ...) so drift in
 * machine load affects both variants alike.
 */
import { PgClient } from "@effect/sql-pg";
import { RequestRevision } from "@std/server/sql/request-revision";
import { decodeRows } from "@std/server/sql/rows";
import { Transactions } from "@std/server/sql/transactions";
import { wakeWorkerAfterCommit, WORKER_CHANNEL } from "@std/server/sql/wake-up";
import { Duration, Effect, Fiber, Queue, Random, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { now } from "./clock.ts";
import { runClients, stopSignal } from "./load.ts";
import { summarize } from "./stats.ts";
import type { Summary } from "./stats.ts";

/** The variant that sends `NOTIFY` inside the save transaction. */
const IN_TRANSACTION = "in-transaction";

/** The variant that registers the wake-up after commit, as STD does. */
const AFTER_COMMIT = "after-commit";

/** The acting user of every probe save. */
const ACTOR = "01960000-0000-7000-8000-0000000000aa";

/** The class of every probe record. */
const CLASS_ID = "01960000-0000-7000-8000-0000000000bb";

/** One save. */
interface SaveSample {
  readonly startedAt: number;
  readonly totalMs: number;
  readonly ok: boolean;
}

/** One measured run. */
export interface ThroughputRun {
  readonly variant: typeof AFTER_COMMIT | typeof IN_TRANSACTION;
  readonly durationMs: number;
  readonly saves: number;
  readonly failed: number;
  readonly savesPerSecond: number;
  readonly latency: Summary;
  /** Notifications the listener received during the run, warmup included. */
  readonly notifications: number;
}

/** A run and its latency samples. */
interface MeasuredRun {
  readonly run: ThroughputRun;
  readonly latencies: readonly number[];
}

/** Totals of one variant over all its runs. */
export interface VariantTotals {
  readonly variant: ThroughputRun["variant"];
  readonly savesPerSecond: number;
  readonly latency: Summary;
}

/** Result of probe 6. */
export interface NotifyProbeResult {
  readonly options: NotifyProbeOptions;
  readonly runs: readonly ThroughputRun[];
  readonly totals: readonly VariantTotals[];
  /** In-transaction throughput divided by after-commit throughput. */
  readonly throughputRatio: number;
}

/** Options of probe 6. */
export interface NotifyProbeOptions {
  readonly clients: number;
  /** Rows in the root table; saves pick one at random. */
  readonly records: number;
  /** Measured time of each run. */
  readonly durationMs: number;
  /** Unmeasured load before each run. */
  readonly warmupMs: number;
  /** Pairs of runs (after-commit, then in-transaction). */
  readonly rounds: number;
}

const decodeIds = decodeRows(Schema.Struct({ id: Schema.String }));

const decodeVersion = decodeRows(Schema.Struct({ version: Schema.String }));

/**
 * Creates and fills the save tables.
 * @param records - Rows in `probe_record`.
 * @returns The record IDs.
 */
const setupSaves = Effect.fn("setupSaves")(function* setup(records: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE probe_record (
    id uuid PRIMARY KEY, class_id uuid NOT NULL, version int8 NOT NULL,
    updated_at timestamptz(3) NOT NULL, updated_by uuid NOT NULL, name text NOT NULL)`;
  yield* sql`INSERT INTO probe_record (id, class_id, version, updated_at, updated_by, name)
    SELECT uuidv7(), ${CLASS_ID}::uuid, 1, now(), ${ACTOR}::uuid, 'record ' || g
    FROM generate_series(1, ${String(records)}::int8) AS g`;
  yield* sql`CREATE TABLE probe_change (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    record_id uuid NOT NULL REFERENCES probe_record (id),
    record_version int8 NOT NULL, changed_at timestamptz(3) NOT NULL,
    changed_by uuid NOT NULL, revision int8 NOT NULL, payload jsonb NOT NULL)`;
  yield* sql`CREATE INDEX probe_change_record ON probe_change (record_id, record_version)`;
  yield* sql`VACUUM (ANALYZE) probe_record`;

  return yield* sql`SELECT id::text AS id FROM probe_record`.pipe(
    Effect.flatMap(decodeIds),
    Effect.map((rows) => rows.map((row) => row.id))
  );
});

/**
 * One save transaction.
 * @param ids - Record IDs to pick from.
 * @param notifyInTransaction - Send `NOTIFY` inside the transaction.
 * @returns The sample.
 */
const save = (ids: readonly string[], notifyInTransaction: boolean) =>
  Effect.gen(function* oneSave() {
    const { request } = yield* Transactions;
    const index = yield* Random.nextIntBetween(0, ids.length - 1);
    const id = ids[index] ?? "";
    const startedAt = yield* now;

    const ok = yield* request(
      Effect.gen(function* saveRecord() {
        const { revision } = yield* RequestRevision;
        const sql = yield* SqlClient.SqlClient;

        const [row] = yield* sql`
          SELECT version::text AS version FROM probe_record
          WHERE id = ${id}::uuid FOR NO KEY UPDATE`.pipe(
          Effect.flatMap(decodeVersion)
        );

        const current = row?.version ?? "0";
        const next = String(BigInt(current) + 1n);
        const name = `record ${id} v${next}`;

        yield* sql`
          UPDATE probe_record
          SET version = ${next}::int8, name = ${name}, updated_at = now(), updated_by = ${ACTOR}::uuid
          WHERE id = ${id}::uuid AND version = ${current}::int8`;
        yield* sql`
          INSERT INTO probe_change (record_id, record_version, changed_at, changed_by, revision, payload)
          VALUES (${id}::uuid, ${next}::int8, now(), ${ACTOR}::uuid, ${String(revision)}::int8,
                  jsonb_build_object('name', ${name}::text))`;

        yield* notifyInTransaction
          ? Effect.asVoid(sql`SELECT pg_notify(${WORKER_CHANNEL}, ${id})`)
          : wakeWorkerAfterCommit;
      })
    ).pipe(
      Effect.as(true),
      Effect.catchTag("DatabaseError", () => Effect.succeed(false))
    );

    const sample: SaveSample = {
      ok,
      startedAt,
      totalMs: (yield* now) - startedAt,
    };

    return sample;
  });

/**
 * One measured run of one variant.
 * @param options - Probe options.
 * @param ids - Record IDs.
 * @param variant - Where the wake-up is sent.
 * @param received - Counts notifications.
 * @returns The run's measurements.
 */
const measureRun = (
  options: NotifyProbeOptions,
  ids: readonly string[],
  variant: ThroughputRun["variant"],
  received: { count: number }
) =>
  Effect.gen(function* oneRun() {
    const stop = stopSignal();
    const notificationsBefore = received.count;

    const load = yield* Effect.forkChild(
      runClients(options.clients, stop, save(ids, variant === IN_TRANSACTION))
    );

    yield* Effect.sleep(Duration.millis(options.warmupMs));

    const from = yield* now;
    yield* Effect.sleep(Duration.millis(options.durationMs));
    const to = yield* now;
    stop.stopped = true;

    const samples = (yield* Fiber.join(load)).filter(
      (sample) => sample.startedAt >= from && sample.startedAt <= to
    );

    const durationMs = to - from;

    const run: ThroughputRun = {
      durationMs,
      failed: samples.filter((sample) => !sample.ok).length,
      latency: summarize(samples.map((sample) => sample.totalMs)),
      notifications: received.count - notificationsBefore,
      saves: samples.length,
      savesPerSecond:
        samples.length / Duration.toSeconds(Duration.millis(durationMs)),
      variant,
    };

    const measured: MeasuredRun = {
      latencies: samples.map((sample) => sample.totalMs),
      run,
    };

    return measured;
  });

const totalsOf = (
  runs: readonly MeasuredRun[],
  variant: ThroughputRun["variant"]
): VariantTotals => {
  const mine = runs.filter((measured) => measured.run.variant === variant);
  const latencies = mine.flatMap((measured) => measured.latencies);

  const durationMs = mine.reduce(
    (sum, measured) => sum + measured.run.durationMs,
    0
  );

  return {
    latency: summarize(latencies),
    savesPerSecond:
      durationMs <= 0
        ? 0
        : latencies.length / Duration.toSeconds(Duration.millis(durationMs)),
    variant,
  };
};

/**
 * Runs probe 6 on the current database.
 * @param options - Clients, table size and durations.
 * @returns Throughput and latency of both variants.
 */
export const runNotifyProbe = Effect.fn("runNotifyProbe")(function* notifyProbe(
  options: NotifyProbeOptions
) {
  const ids = yield* setupSaves(options.records);
  const client = yield* PgClient.PgClient;
  const queue = yield* client.listen(WORKER_CHANNEL);
  const received = { count: 0 };
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(queue).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            received.count += 1;
          })
        )
      )
    ).pipe(Effect.ignore)
  );

  const runs: MeasuredRun[] = [];

  for (let round = 0; round < options.rounds; round += 1) {
    runs.push(
      yield* measureRun(options, ids, AFTER_COMMIT, received),
      yield* measureRun(options, ids, IN_TRANSACTION, received)
    );
  }

  const afterCommit = totalsOf(runs, AFTER_COMMIT);
  const inTransaction = totalsOf(runs, IN_TRANSACTION);

  const result: NotifyProbeResult = {
    options,
    runs: runs.map((measured) => measured.run),
    throughputRatio:
      afterCommit.savesPerSecond === 0
        ? 0
        : inTransaction.savesPerSecond / afterCommit.savesPerSecond,
    totals: [afterCommit, inTransaction],
  };

  return result;
});
