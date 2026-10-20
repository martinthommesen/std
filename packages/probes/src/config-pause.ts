/**
 * Probe 1 (plan 0F; Contracts 1.3, 1.4, Open question 1): what config
 * commits cost requests.
 *
 * Closed-loop clients run short request transactions through
 * `Transactions.request` (`BEGIN`, two `SET LOCAL`s, `core.begin_request()`,
 * one primary-key read, `COMMIT`). Each sample records the request start
 * (until the request's code runs, so it includes `begin_request()` and any
 * wait for `CONFIG_KEY`) and the whole request. Scenarios:
 *
 * - `baseline`: load only.
 * - `stream`: load while a stream of config commits runs on the
 *   coordinator's dedicated connection. Each is a realistic main
 *   transaction: `CONFIG_KEY` exclusive, a small DDL on a dummy table
 *   (`ALTER COLUMN ... SET DEFAULT`), a journal row, the revision bump and
 *   its `pg_notify`.
 * - `longRequest`: one config commit while a 30 s request transaction and a
 *   2 s write batch hold `CONFIG_KEY` shared. The commit waits 200 ms per
 *   attempt, retries, and gives up with `SchemaLockTimeout`; requests are
 *   paused only while an attempt waits.
 * - `batchOnly`: the same with only the 2 s write batch, so a retry commits.
 * - `tableLock`: a plain session (like psql) holds a lock on the dummy
 *   table, so the commit holds `CONFIG_KEY` while its DDL waits the 2 s
 *   `lock_timeout`: the worst pause per attempt.
 *
 * A stall is a run of requests slower than `STALL_MS` that overlap in time.
 */
import { randomUUID } from "node:crypto";

import {
  bumpRevision,
  CONFIG_LOCK_TIMEOUT,
  MAIN_LOCK_TIMEOUT,
} from "@std/server/sql/config-commit";
import type { ConfigCommitOptions } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import type { DedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { lockWaiting } from "@std/server/sql/statement-marks";
import { Transactions } from "@std/server/sql/transactions";
import { TestDatabase } from "@std/testing/test-database";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Random,
  Schema,
  Cause,
} from "effect";
import { SqlClient } from "effect/sql";

import { now } from "./clock.ts";
import { runClients, stopSignal } from "./load.ts";
import { longestGap, summarize } from "./stats.ts";
import type { Summary } from "./stats.ts";

/** A request slower than this counts toward a stall. */
export const STALL_MS = 50;

/** Load runs this long before a scenario's window opens. */
const WARMUP = Duration.millis(500);

/** Load runs this long after a scenario's window closes. */
const COOLDOWN = Duration.millis(300);

/** How long the blockers run before the config commit starts. */
const BLOCKER_LEAD = Duration.millis(200);

/** Rows each write-batch statement inserts. */
const BATCH_STATEMENT_ROWS = 100;

/** Stalls listed per window in the report. */
const MAX_LISTED_STALLS = 12;

/** One short request. */
export interface RequestSample {
  readonly startedAt: number;
  readonly endedAt: number;
  /** Until the request's code runs: `BEGIN`, `SET LOCAL`s, `begin_request()`. */
  readonly startMs: number;
  /** The whole request, commit included. */
  readonly totalMs: number;
  readonly ok: boolean;
}

/** A run of overlapping slow requests. */
export interface Stall {
  /** Start of the first slow request, from the window's start. */
  readonly atMs: number;
  /** The slowest request of the run. */
  readonly ms: number;
}

/** Request statistics for one window. */
export interface WindowStats {
  readonly durationMs: number;
  readonly requests: number;
  readonly failed: number;
  readonly requestsPerSecond: number;
  readonly start: Summary;
  readonly total: Summary;
  /** The longest time no request completed. */
  readonly longestGapMs: number;
  readonly stallCount: number;
  readonly stalls: readonly Stall[];
}

/** How one config commit ended. */
export interface CommitOutcome {
  readonly outcome: "committed" | "SchemaLockTimeout" | "failed";
  readonly elapsedMs: number;
  /** Attempts that got `CONFIG_KEY` and ran their work. */
  readonly attemptsWithLock: number;
  /** Total attempts when the commit gave up, from `SchemaLockTimeout`. */
  readonly attempts: number | null;
  /** Blocking sessions named by `SchemaLockTimeout`. */
  readonly holders: readonly string[];
}

/** Result of the stream scenario. */
export interface StreamResult {
  readonly window: WindowStats;
  readonly commits: number;
  readonly commitsPerSecond: number;
  /** Whole config commits, as the coordinator sees them. */
  readonly commitMs: Summary;
  /** From `CONFIG_KEY` granted until commit returned: the request pause each commit causes. */
  readonly heldMs: Summary;
}

/** Result of the long-request scenario. */
export interface LongRequestResult {
  readonly window: WindowStats;
  readonly commit: CommitOutcome;
  readonly longRequestPid: number;
  readonly longRequestMs: number;
  /** The long request was still running when the config commit gave up. */
  readonly longRequestRunningAtEnd: boolean;
  /** How the long request ended (`completed`, or the SQLSTATE). */
  readonly longRequestOutcome: string;
  readonly batchRows: number;
}

/** Result of a scenario with one config commit. */
export interface SingleCommitResult {
  readonly window: WindowStats;
  readonly commit: CommitOutcome;
}

/** Options of probe 1. */
export interface ConfigPauseOptions {
  /** Concurrent request clients. */
  readonly clients: number;
  /** Rows in the table the requests read. */
  readonly items: number;
  readonly baselineMs: number;
  readonly streamCommits: number;
  /** Pause between stream commits. */
  readonly streamGapMs: number;
  /** Length of the long request (the contract's 30 s request). */
  readonly longRequestMs: number;
  /** Length of the write batch. */
  readonly batchMs: number;
  /** How long a plain session holds the dummy table in `tableLock`. */
  readonly tableHoldMs: number;
  /** Retry delays of the single config commits (default: Contracts 1.4). */
  readonly retryDelays?: ConfigCommitOptions["retryDelays"];
  /** Cancel the long request once the config commit gave up, instead of waiting for it. */
  readonly cancelLongRequest: boolean;
}

/** Result of probe 1. */
export interface ConfigPauseResult {
  readonly options: ConfigPauseOptions;
  readonly baseline: WindowStats;
  readonly stream: StreamResult;
  readonly longRequest: LongRequestResult;
  readonly batchOnly: SingleCommitResult;
  readonly tableLock: SingleCommitResult;
  /** Contracts 1.4: `CONFIG_KEY` wait + DDL lock wait + main transaction (stream p95 of `heldMs`). */
  readonly boundMs: number;
}

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeActive = decodeRows(Schema.Struct({ active: Schema.Boolean }));

const millisOf = (setting: string): number =>
  setting.endsWith("ms")
    ? Number(setting.slice(0, -"ms".length))
    : Duration.toMillis(Duration.seconds(Number(setting.slice(0, -1))));

/** The `CONFIG_KEY` wait of an attempt, in milliseconds. */
export const CONFIG_WAIT_MS = millisOf(CONFIG_LOCK_TIMEOUT);

/** The DDL lock wait of an attempt, in milliseconds. */
export const DDL_WAIT_MS = millisOf(MAIN_LOCK_TIMEOUT);

/**
 * Creates the tables of probe 1.
 * @param items - Rows in `probe_item`.
 * @returns Completes when the tables exist.
 */
export const setupConfigPause = Effect.fn("setupConfigPause")(function* setup(
  items: number
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE probe_item (id int8 PRIMARY KEY, name text NOT NULL, version int8 NOT NULL DEFAULT 1)`;
  yield* sql`INSERT INTO probe_item (id, name) SELECT g, 'item ' || g FROM generate_series(1, ${String(items)}::int8) AS g`;
  yield* sql`CREATE TABLE probe_dummy (id int8 PRIMARY KEY, label text)`;
  yield* sql`CREATE TABLE probe_journal (id uuid PRIMARY KEY DEFAULT uuidv7(), change_set_id uuid NOT NULL, note text NOT NULL)`;
  yield* sql`CREATE TABLE probe_batch (id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL)`;
  yield* sql`VACUUM (ANALYZE) probe_item`;

  return yield* Effect.void;
});

/**
 * One short request: begin, read one row by primary key, commit.
 * @param items - Rows in `probe_item`.
 * @returns The sample.
 */
const shortRequest = (items: number) =>
  Effect.gen(function* oneShortRequest() {
    const { request } = yield* Transactions;
    const id = yield* Random.nextIntBetween(1, items);
    const startedAt = yield* now;
    let begunAt = startedAt;

    const ok = yield* request(
      Effect.gen(function* readOne() {
        begunAt = yield* now;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT name, version FROM probe_item WHERE id = ${String(id)}::int8`;
      })
    ).pipe(
      Effect.as(true),
      Effect.catchTag("DatabaseError", () => Effect.succeed(false))
    );

    const endedAt = yield* now;

    const sample: RequestSample = {
      endedAt,
      ok,
      startMs: begunAt - startedAt,
      startedAt,
      totalMs: endedAt - startedAt,
    };

    return sample;
  });

/**
 * Groups slow requests that overlap in time.
 * @param samples - Requests of the window.
 * @param from - The window's start.
 * @returns The stalls, in time order.
 */
const findStalls = (
  samples: readonly RequestSample[],
  from: number
): readonly Stall[] => {
  const slow = samples
    .filter((sample) => sample.totalMs >= STALL_MS)
    .toSorted((left, right) => left.startedAt - right.startedAt);

  const stalls: { start: number; end: number; ms: number }[] = [];

  for (const sample of slow) {
    const last = stalls.at(-1);

    if (last !== undefined && sample.startedAt <= last.end) {
      last.end = Math.max(last.end, sample.endedAt);
      last.ms = Math.max(last.ms, sample.totalMs);
    } else {
      stalls.push({
        end: sample.endedAt,
        ms: sample.totalMs,
        start: sample.startedAt,
      });
    }
  }

  return stalls.map((stall) => ({ atMs: stall.start - from, ms: stall.ms }));
};

/**
 * Request statistics of the requests that started in a window.
 * @param samples - All samples of the run.
 * @param from - Window start.
 * @param to - Window end.
 * @returns The statistics.
 */
export const windowStats = (
  samples: readonly RequestSample[],
  from: number,
  to: number
): WindowStats => {
  const inside = samples.filter(
    (sample) => sample.startedAt >= from && sample.startedAt <= to
  );

  const stalls = findStalls(inside, from);
  const durationMs = to - from;

  return {
    durationMs,
    failed: inside.filter((sample) => !sample.ok).length,
    longestGapMs: longestGap(
      samples.map((sample) => sample.endedAt),
      from,
      to
    ),
    requests: inside.length,
    requestsPerSecond:
      durationMs <= 0
        ? 0
        : inside.length / Duration.toSeconds(Duration.millis(durationMs)),
    stallCount: stalls.length,
    stalls: stalls.slice(0, MAX_LISTED_STALLS),
    start: summarize(inside.map((sample) => sample.startMs)),
    total: summarize(inside.map((sample) => sample.totalMs)),
  };
};

/**
 * Runs `scenario` under request load and returns its result with the
 * statistics of the requests that started while it ran.
 * @param options - Clients and table size.
 * @param scenario - The scenario.
 * @returns The scenario's result and the window statistics.
 */
const underLoad = <A, E, R>(
  options: ConfigPauseOptions,
  scenario: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* withLoad() {
    const stop = stopSignal();

    const load = yield* Effect.forkChild(
      runClients(options.clients, stop, shortRequest(options.items))
    );

    yield* Effect.sleep(WARMUP);

    const from = yield* now;
    const result = yield* scenario;
    const to = yield* now;
    yield* Effect.sleep(COOLDOWN);
    stop.stopped = true;

    const samples = yield* Fiber.join(load);

    return { result, window: windowStats(samples, from, to) };
  });

/** Counts attempts and records when the last one got `CONFIG_KEY`. */
interface AttemptCounter {
  attempts: number;
  lockedAt: number;
}

/**
 * The main transaction of a small DDL change set.
 * @param counter - Counts attempts that got `CONFIG_KEY`.
 * @returns The work, ending with the revision bump.
 */
const smallChangeSet = (counter: AttemptCounter) =>
  Effect.gen(function* smallDdlChangeSet() {
    counter.lockedAt = yield* now;
    counter.attempts += 1;

    const sql = yield* SqlClient.SqlClient;
    const changeSetId = randomUUID();
    yield* lockWaiting(
      sql.unsafe(
        `ALTER TABLE probe_dummy ALTER COLUMN label SET DEFAULT 'change ${changeSetId}'`
      )
    );
    yield* sql`INSERT INTO probe_journal (change_set_id, note) VALUES (${changeSetId}::uuid, ${"probe change set"})`;
    yield* bumpRevision(changeSetId);
  });

/**
 * Runs one small DDL change set on the coordinator's connection.
 * @param coordinator - The dedicated connection.
 * @param retryDelays - Retry delays, or the defaults.
 * @returns How it ended.
 */
const oneCommit = (
  coordinator: DedicatedConnection,
  retryDelays: ConfigCommitOptions["retryDelays"]
) =>
  Effect.gen(function* timedCommit() {
    const counter: AttemptCounter = { attempts: 0, lockedAt: 0 };
    const started = yield* now;

    const exit = yield* Effect.exit(
      coordinator.transactions.configCommit(
        smallChangeSet(counter),
        retryDelays === undefined ? {} : { retryDelays }
      )
    );

    const elapsedMs = (yield* now) - started;

    if (Exit.isSuccess(exit)) {
      const outcome: CommitOutcome = {
        attempts: null,
        attemptsWithLock: counter.attempts,
        elapsedMs,
        holders: [],
        outcome: "committed",
      };

      return outcome;
    }

    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    const timedOut = failure?._tag === "SchemaLockTimeout";

    const outcome: CommitOutcome = {
      attempts: timedOut ? failure.attempts : null,
      attemptsWithLock: counter.attempts,
      elapsedMs,
      holders: timedOut
        ? failure.holders.map(
            (holder) => `${holder.pid} (${holder.applicationName})`
          )
        : [],
      outcome: timedOut ? "SchemaLockTimeout" : "failed",
    };

    return outcome;
  });

/**
 * The stream scenario: back-to-back config commits under load.
 * @param options - Probe options.
 * @param coordinator - The coordinator's dedicated connection.
 * @returns The stream's result.
 */
const measureStream = (
  options: ConfigPauseOptions,
  coordinator: DedicatedConnection
) =>
  underLoad(
    options,
    Effect.gen(function* commitStream() {
      const commitMs: number[] = [];
      const heldMs: number[] = [];
      const started = yield* now;

      for (let index = 0; index < options.streamCommits; index += 1) {
        const counter: AttemptCounter = { attempts: 0, lockedAt: 0 };
        const begun = yield* now;
        yield* coordinator.transactions.configCommit(smallChangeSet(counter));
        const ended = yield* now;
        commitMs.push(ended - begun);
        heldMs.push(ended - counter.lockedAt);
        yield* Effect.sleep(Duration.millis(options.streamGapMs));
      }

      return { commitMs, elapsed: (yield* now) - started, heldMs };
    })
  ).pipe(
    Effect.map(({ result, window }): StreamResult => ({
      commitMs: summarize(result.commitMs),
      commits: result.commitMs.length,
      commitsPerSecond:
        result.commitMs.length /
        Duration.toSeconds(Duration.millis(result.elapsed)),
      heldMs: summarize(result.heldMs),
      window,
    }))
  );

/**
 * A request transaction that sleeps in Postgres, holding `CONFIG_KEY` shared.
 * @param ms - How long.
 * @param pid - Receives the backend PID.
 * @returns The request.
 */
const longRequest = (ms: number, pid: Deferred.Deferred<number>) =>
  Effect.gen(function* holdSharedLong() {
    const { request } = yield* Transactions;

    return yield* request(
      Effect.gen(function* sleepInPostgres() {
        const sql = yield* SqlClient.SqlClient;

        const [row] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(
          Effect.flatMap(decodePid)
        );

        yield* Deferred.succeed(pid, row?.pid ?? 0);
        yield* sql`SELECT pg_sleep(${String(Duration.toSeconds(Duration.millis(ms)))}::float8)`;
      })
    );
  });

/**
 * A write batch: one request transaction inserting rows for `ms`.
 * @param ms - How long it writes.
 * @param started - Completed once the batch holds `CONFIG_KEY`.
 * @returns Rows written.
 */
const writeBatch = (ms: number, started: Deferred.Deferred<boolean>) =>
  Effect.gen(function* batchWrites() {
    const { request } = yield* Transactions;

    return yield* request(
      Effect.gen(function* insertForAWhile() {
        const sql = yield* SqlClient.SqlClient;
        yield* Deferred.succeed(started, true);
        const end = (yield* now) + ms;
        let rows = 0;

        while ((yield* now) < end) {
          yield* sql`INSERT INTO probe_batch (note) SELECT 'batch row' FROM generate_series(1, ${String(BATCH_STATEMENT_ROWS)}::int4)`;
          rows += BATCH_STATEMENT_ROWS;
        }

        return rows;
      })
    );
  });

/**
 * One config commit while a long request and a write batch hold
 * `CONFIG_KEY` shared.
 * @param options - Probe options.
 * @param coordinator - The coordinator's dedicated connection.
 * @returns The scenario's result.
 */
export const measureLongRequest = (
  options: ConfigPauseOptions,
  coordinator: DedicatedConnection
) =>
  Effect.gen(function* longRequestScenario() {
    const sql = yield* SqlClient.SqlClient;
    const pid = yield* Deferred.make<number>();
    const batchStarted = yield* Deferred.make<boolean>();
    const longStarted = yield* now;

    const long = yield* Effect.forkChild(
      Effect.exit(longRequest(options.longRequestMs, pid))
    );

    const batch = yield* Effect.forkChild(
      writeBatch(options.batchMs, batchStarted)
    );

    const longPid = yield* Deferred.await(pid);
    yield* Deferred.await(batchStarted);

    const { result, window } = yield* underLoad(
      options,
      Effect.sleep(BLOCKER_LEAD).pipe(
        Effect.andThen(oneCommit(coordinator, options.retryDelays))
      )
    );

    const [running] = yield* sql`
      SELECT count(*) > 0 AS active FROM pg_stat_activity
      WHERE pid = ${longPid} AND state = 'active'`.pipe(
      Effect.flatMap(decodeActive)
    );

    if (options.cancelLongRequest) {
      yield* sql`SELECT pg_cancel_backend(${longPid})`;
    }

    const longExit = yield* Fiber.join(long);
    const longRequestMs = (yield* now) - longStarted;
    const batchRows = yield* Fiber.join(batch);

    const longFailure = Exit.isFailure(longExit)
      ? Option.getOrUndefined(Cause.findErrorOption(longExit.cause))
      : undefined;

    const measured: LongRequestResult = {
      batchRows,
      commit: result,
      longRequestMs,
      longRequestOutcome:
        longFailure === undefined ? "completed" : longFailure.sqlState,
      longRequestPid: longPid,
      longRequestRunningAtEnd: running?.active ?? false,
      window,
    };

    return measured;
  });

/**
 * One config commit while only a write batch holds `CONFIG_KEY` shared.
 * @param options - Probe options.
 * @param coordinator - The coordinator's dedicated connection.
 * @returns The scenario's result.
 */
const measureBatchOnly = (
  options: ConfigPauseOptions,
  coordinator: DedicatedConnection
) =>
  Effect.gen(function* batchOnlyScenario() {
    const batchStarted = yield* Deferred.make<boolean>();

    const batch = yield* Effect.forkChild(
      writeBatch(options.batchMs, batchStarted)
    );

    yield* Deferred.await(batchStarted);

    const { result, window } = yield* underLoad(
      options,
      Effect.sleep(BLOCKER_LEAD).pipe(
        Effect.andThen(oneCommit(coordinator, options.retryDelays))
      )
    );

    yield* Fiber.join(batch);

    const measured: SingleCommitResult = { commit: result, window };

    return measured;
  });

/**
 * One config commit whose DDL waits for a table lock held by a plain
 * session, so it holds `CONFIG_KEY` for the whole DDL lock wait.
 * @param options - Probe options.
 * @param coordinator - The coordinator's dedicated connection.
 * @returns The scenario's result.
 */
const measureTableLock = (
  options: ConfigPauseOptions,
  coordinator: DedicatedConnection
) =>
  Effect.gen(function* tableLockScenario() {
    const database = yield* TestDatabase;
    const reader = yield* database.session("std-probe-table-reader");
    yield* reader.query("BEGIN");
    yield* reader.query("SELECT count(*) FROM probe_dummy");

    const release = yield* Effect.forkChild(
      Effect.sleep(Duration.millis(options.tableHoldMs)).pipe(
        Effect.andThen(reader.query("COMMIT"))
      )
    );

    const { result, window } = yield* underLoad(
      options,
      oneCommit(coordinator, options.retryDelays)
    );

    yield* Fiber.join(release);

    const measured: SingleCommitResult = { commit: result, window };

    return measured;
  });

/**
 * The coordinator's dedicated connection for probe 1.
 * @returns The connection; it closes with the scope.
 */
export const probeCoordinator = makeDedicatedConnection({
  applicationName: "std-probe-coordinator",
});

/**
 * Runs probe 1 on the current database.
 * @param options - Load and scenario settings.
 * @returns Every scenario's measurements.
 */
export const runConfigPauseProbe = Effect.fn("runConfigPauseProbe")(
  function* configPauseProbe(options: ConfigPauseOptions) {
    yield* setupConfigPause(options.items);
    const coordinator = yield* probeCoordinator;

    const baseline = yield* underLoad(
      options,
      Effect.sleep(Duration.millis(options.baselineMs))
    );

    const stream = yield* measureStream(options, coordinator);
    const long = yield* measureLongRequest(options, coordinator);
    const batchOnly = yield* measureBatchOnly(options, coordinator);
    const tableLock = yield* measureTableLock(options, coordinator);

    const result: ConfigPauseResult = {
      baseline: baseline.window,
      batchOnly,
      boundMs: CONFIG_WAIT_MS + DDL_WAIT_MS + stream.heldMs.p95,
      longRequest: long,
      options,
      stream,
      tableLock,
    };

    return result;
  }
);
