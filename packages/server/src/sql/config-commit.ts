/**
 * Config commits: the main transaction of a change set (Contracts 1.4).
 *
 * 1. `BEGIN ISOLATION LEVEL READ COMMITTED`, `SET LOCAL lock_timeout = '200ms'`,
 *    then `pg_advisory_xact_lock(CONFIG_KEY)`, which also drains STD requests.
 * 2. `SET LOCAL lock_timeout = '2s'` and `SET LOCAL statement_timeout = '15s'`.
 * 3. The caller's work (DDL, definition rows, journal), which ends by calling
 *    `bumpRevision`: it bumps `core.config_state` and runs
 *    `pg_notify('std_config', '<revision>')`.
 * 4. `COMMIT`.
 *
 * When the `CONFIG_KEY` wait, or a DDL statement the caller marked with
 * `lockWaiting` (`statement-marks.ts`), hits its lock timeout (SQLSTATE
 * 55P03), the transaction rolls back and is retried after 0.5, 1, 2 and 4 s
 * with jitter, 5 attempts in total (`Effect.retry` with `retrySchedule`,
 * jittered by `Schedule.jittered`, a factor in [0.8, 1.2]). Every attempt
 * starts from a fresh transaction state and sets the same lock timeouts.
 * Then it fails with `SchemaLockTimeout` naming the sessions that blocked
 * the last attempt. Every other failure, a 55P03 from any other statement
 * included, propagates at once.
 */
import type { PgClient } from "@effect/sql-pg";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

import {
  AttemptLockTimedOut,
  WaitedLockSchema,
} from "./attempt-lock-timed-out.ts";
import type { WaitedLock } from "./attempt-lock-timed-out.ts";
import {
  DatabaseError,
  hygienic,
  SQLSTATE_LOCK_NOT_AVAILABLE,
  sqlStateOf,
} from "./errors.ts";
import type { HygienicError } from "./errors.ts";
import { advisoryClassId, advisoryObjectId, CONFIG_KEY } from "./locks.ts";
import { parseConfigState } from "./request-revision.ts";
import type { ConfigState } from "./request-revision.ts";
import { CurrentTransaction } from "./transaction-context.ts";
import { TransactionRefused } from "./transaction-refused.ts";
import { control, TransactionState } from "./transaction-state.ts";
import {
  currentState,
  provideJoined,
  runAtConfigState,
} from "./transaction.ts";
import type { TransactionServices, TransactionSetup } from "./transaction.ts";

/** The NOTIFY channel config commits announce new revisions on. */
export const CONFIG_CHANNEL = "std_config";

/** `lock_timeout` while waiting for `CONFIG_KEY`. */
export const CONFIG_LOCK_TIMEOUT = "200ms";

/** `lock_timeout` for the DDL of the main transaction. */
export const MAIN_LOCK_TIMEOUT = "2s";

/** `statement_timeout` of the main transaction. */
export const MAIN_STATEMENT_TIMEOUT = "15s";

/** Delays before attempts 2 to 5 (Contracts 1.4). */
export const DEFAULT_RETRY_DELAYS: readonly Duration.Duration[] = [
  Duration.millis(500),
  Duration.seconds(1),
  Duration.seconds(2),
  Duration.seconds(4),
];

/** How often the blocking sessions of a waiting attempt are sampled. */
const BLOCKER_SAMPLE_INTERVAL = Duration.millis(50);

/** A session that held a lock a config commit waited for. */
export const LockHolderSchema = Schema.Struct({
  applicationName: Schema.String,
  clientAddress: Schema.NullOr(Schema.String),
  /** Granted locks of the session, for example `relation AccessShareLock on acme.asset`. */
  locks: Schema.Array(Schema.String),
  pid: Schema.Int,
  state: Schema.NullOr(Schema.String),
});

/** A session that held a lock a config commit waited for. */
export type LockHolder = typeof LockHolderSchema.Type;

/** A config commit gave up after its lock-timeout retries. Nothing was applied. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaLockTimeout extends Schema.TaggedError<SchemaLockTimeout>()(
  "SchemaLockTimeout",
  {
    attempts: Schema.Int,
    holders: Schema.Array(LockHolderSchema),
  }
) {
  /**
   * Names the blocking sessions by PID and application name only.
   * @returns The message.
   */
  override get message(): string {
    const holders = this.holders.map(
      (holder) => `${holder.pid} (${holder.applicationName})`
    );

    const blockers =
      holders.length === 0 ? "unknown sessions" : holders.join(", ");

    return `Schema lock timeout after ${this.attempts} attempts; blocked by ${blockers}`;
  }
}

/**
 * Whether an attempt's cause holds nothing but lock timeouts. Only then is
 * the attempt retried; a defect, an interruption or any other failure next
 * to the timeout (a failing error handler, a dying finalizer) propagates
 * with its cause intact.
 * @param cause - The cause of a failed attempt.
 * @returns `true` when every reason is a failure with SQLSTATE 55P03, raw
 *   (`SqlError`) or sanitized (`DatabaseError`).
 */
const onlyLockTimeouts = <E>(cause: Cause.Cause<E>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => {
    if (!Cause.isFailReason(reason)) {
      return false;
    }

    const failure = reason.error;

    const raw =
      isSqlError(failure) &&
      sqlStateOf(failure) === SQLSTATE_LOCK_NOT_AVAILABLE;

    const sanitized =
      failure instanceof DatabaseError &&
      failure.sqlState === SQLSTATE_LOCK_NOT_AVAILABLE;

    return raw || sanitized;
  });

/**
 * The retry policy of a config commit before jitter: one recurrence after
 * each delay, in order, then stop.
 * @param delays - The delays before attempts 2, 3, and so on.
 * @returns The schedule.
 */
export const retrySchedule = (
  delays: readonly Duration.Input[]
): Schedule.Schedule<unknown> => {
  const [first, ...rest] = delays;

  if (first === undefined) {
    return Schedule.recurs(0);
  }

  let schedule: Schedule.Schedule<unknown> = Schedule.duration(first);

  for (const delay of rest) {
    schedule = Schedule.concat(schedule, Schedule.duration(delay));
  }

  return schedule;
};

/** Options of a config commit. */
export interface ConfigCommitOptions {
  /** Delays before each retry; the number of attempts is one more. */
  readonly retryDelays?: readonly Duration.Input[];
}

/** The type of `configCommit`. */
export type ConfigCommit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: ConfigCommitOptions
) => Effect.Effect<
  A,
  HygienicError<E | SqlError | SchemaLockTimeout>,
  Exclude<R, TransactionServices>
>;

const LOCK_CONFIG_KEY = `SELECT pg_advisory_xact_lock(${CONFIG_KEY.toString()})`;

const HOLDERS_QUERY = `
SELECT a.pid,
       coalesce(a.application_name, '') AS application_name,
       a.client_addr::text AS client_addr,
       a.state,
       coalesce(
         array_agg(
           l.locktype || ' ' || l.mode ||
           CASE WHEN l.relation IS NULL THEN '' ELSE ' on ' || l.relation::regclass::text END
           ORDER BY l.locktype, l.mode
         ) FILTER (WHERE l.locktype IS NOT NULL),
         '{}'
       ) AS locks
FROM pg_stat_activity a
LEFT JOIN pg_locks l ON l.pid = a.pid AND l.granted
WHERE a.pid <> pg_backend_pid()
  AND (a.pid = ANY($1::int4[])
       OR (cardinality($1::int4[]) = 0 AND a.pid IN (
         SELECT pid FROM pg_locks
         WHERE locktype = 'advisory' AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = $2::oid AND objid = $3::oid AND objsubid = 1)))
GROUP BY a.pid, a.application_name, a.client_addr, a.state
ORDER BY a.pid`;

const HolderRows = Schema.Array(
  Schema.Struct({
    application_name: Schema.String,
    client_addr: Schema.NullOr(Schema.String),
    locks: Schema.Array(Schema.String),
    pid: Schema.Int,
    state: Schema.NullOr(Schema.String),
  })
);

const decodeHolderRows = Schema.decodeUnknownEffect(HolderRows);

const PidRows = Schema.Array(Schema.Struct({ pid: Schema.Int }));

const decodePidRows = Schema.decodeUnknownEffect(PidRows);

const decodeWaitedRows = Schema.decodeUnknownEffect(
  Schema.Array(WaitedLockSchema)
);

/**
 * The relation lock modes each mode conflicts with (the table in the
 * Postgres documentation, "Explicit Locking").
 */
const CONFLICTING_MODES: ReadonlyMap<string, readonly string[]> = new Map([
  ["AccessShareLock", ["AccessExclusiveLock"]],
  ["RowShareLock", ["ExclusiveLock", "AccessExclusiveLock"]],
  [
    "RowExclusiveLock",
    [
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
  [
    "ShareUpdateExclusiveLock",
    [
      "ShareUpdateExclusiveLock",
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
  [
    "ShareLock",
    [
      "RowExclusiveLock",
      "ShareUpdateExclusiveLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
  [
    "ShareRowExclusiveLock",
    [
      "RowExclusiveLock",
      "ShareUpdateExclusiveLock",
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
  [
    "ExclusiveLock",
    [
      "RowShareLock",
      "RowExclusiveLock",
      "ShareUpdateExclusiveLock",
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
  [
    "AccessExclusiveLock",
    [
      "AccessShareLock",
      "RowShareLock",
      "RowExclusiveLock",
      "ShareUpdateExclusiveLock",
      "ShareLock",
      "ShareRowExclusiveLock",
      "ExclusiveLock",
      "AccessExclusiveLock",
    ],
  ],
]);

const CONFLICTING_HOLDERS_QUERY = `
SELECT DISTINCT pid FROM pg_locks
WHERE granted AND locktype = 'relation'
  AND relation = $1::oid AND mode = ANY($2::text[])
  AND pid <> pg_backend_pid()
ORDER BY pid`;

const WAITED_LOCK_QUERY = `
SELECT relation::text AS relation, mode FROM pg_locks
WHERE pid = $1::int4 AND NOT granted AND locktype = 'relation'
LIMIT 1`;

/** What the sampler saw of one attempt's lock waits. */
interface AttemptWait {
  /** Every PID seen blocking the attempt; never cleared during the attempt. */
  readonly blockers: Set<number>;
  /** The last relation lock the attempt was seen waiting for. */
  waited?: WaitedLock;
}

/**
 * The sessions that blocked a config commit. Without sampled blockers, the
 * sessions holding a lock that conflicts with the relation lock the attempt
 * was seen waiting for; failing that, the sessions holding `CONFIG_KEY`.
 * @param monitor - A pooled client, outside the failed transaction.
 * @param pids - Blocking PIDs sampled while the attempt waited.
 * @param waited - The relation lock the attempt was seen waiting for, if any.
 * @returns The holders, by PID.
 */
export const describeLockHolders: (
  monitor: PgClient.PgClient,
  pids: readonly number[],
  waited?: WaitedLock
) => Effect.Effect<readonly LockHolder[], SqlError> = Effect.fn(
  "ConfigCommit.describeLockHolders"
)(function* describeHolders(
  monitor: PgClient.PgClient,
  pids: readonly number[],
  waited?: WaitedLock
) {
  const conflicting = CONFLICTING_MODES.get(waited?.mode ?? "");
  let holderPids = pids;

  if (holderPids.length === 0 && waited !== undefined && conflicting) {
    const rows = yield* monitor.unsafe(CONFLICTING_HOLDERS_QUERY, [
      waited.relation,
      `{${conflicting.join(",")}}`,
    ]);

    holderPids = (yield* decodePidRows(rows).pipe(Effect.orDie)).map(
      (row) => row.pid
    );
  }

  const raw = yield* monitor.unsafe(HOLDERS_QUERY, [
    `{${holderPids.join(",")}}`,
    String(advisoryClassId(CONFIG_KEY)),
    String(advisoryObjectId(CONFIG_KEY)),
  ]);

  const rows = yield* decodeHolderRows(raw).pipe(Effect.orDie);

  return rows.map((row): LockHolder => ({
    applicationName: row.application_name,
    clientAddress: row.client_addr,
    locks: row.locks,
    pid: row.pid,
    state: row.state,
  }));
});

/**
 * Samples a backend's blockers (`pg_blocking_pids`) and the relation lock it
 * waits for, at once and then every 50 ms, until interrupted. Samples only
 * add: the sampler outlives the wait (it stops with the attempt's scope,
 * after the timeout and the `ROLLBACK`), and a sample taken then sees no
 * wait at all, which must not erase what was seen during it.
 * @param monitor - A pooled client, outside the transaction.
 * @param pid - The backend of the config commit.
 * @param wait - Collects what was seen.
 * @returns An effect that runs until interrupted.
 */
const sampleBlockers = (
  monitor: PgClient.PgClient,
  pid: number,
  wait: AttemptWait
): Effect.Effect<void> =>
  Effect.gen(function* sampleWait() {
    const blockers = yield* monitor
      .unsafe("SELECT unnest(pg_blocking_pids($1::int4)) AS pid", [pid])
      .pipe(Effect.flatMap((rows) => decodePidRows(rows)));

    for (const row of blockers) {
      wait.blockers.add(row.pid);
    }

    const [waited] = yield* monitor
      .unsafe(WAITED_LOCK_QUERY, [pid])
      .pipe(Effect.flatMap((rows) => decodeWaitedRows(rows)));

    if (waited !== undefined) {
      wait.waited = waited;
    }
  }).pipe(
    Effect.ignore,
    Effect.repeat(Schedule.spaced(BLOCKER_SAMPLE_INTERVAL)),
    Effect.asVoid
  );

const configSetup =
  (
    monitor: PgClient.PgClient,
    wait: AttemptWait
  ): TransactionSetup<ConfigState> =>
  (connection, state) =>
    Effect.gen(function* beginConfigCommitSetup() {
      yield* control(
        connection,
        `SET LOCAL lock_timeout = '${CONFIG_LOCK_TIMEOUT}'`
      );
      const pids = yield* control(connection, "SELECT pg_backend_pid() AS pid");
      const [backend] = yield* decodePidRows(pids).pipe(Effect.orDie);

      if (backend !== undefined) {
        yield* Effect.forkScoped(sampleBlockers(monitor, backend.pid, wait));
      }

      yield* control(connection, LOCK_CONFIG_KEY).pipe(
        Effect.tapError(state.recordLockWaitFailure)
      );
      yield* control(
        connection,
        `SET LOCAL lock_timeout = '${MAIN_LOCK_TIMEOUT}'`
      );
      yield* control(
        connection,
        `SET LOCAL statement_timeout = '${MAIN_STATEMENT_TIMEOUT}'`
      );

      const rows = yield* control(
        connection,
        "SELECT revision, change_set_id FROM core.config_state"
      );

      return yield* parseConfigState(rows);
    });

const lockUpgradeRefused = (kind: string): Effect.Effect<never> =>
  Effect.die(
    new TransactionRefused({
      detail: `a config commit inside a ${kind} transaction (CONFIG_KEY cannot be upgraded)`,
      reason: "nesting",
    })
  );

/**
 * Builds config commits over a client.
 * @param client - The client the transaction runs on: the pool, or the coordinator's dedicated connection.
 * @param monitor - A pooled client used to sample blocking sessions.
 * @returns The `configCommit` function.
 */
export const makeConfigCommit = (
  client: PgClient.PgClient,
  monitor: PgClient.PgClient
): ConfigCommit => {
  /**
   * One attempt, on a fresh transaction state. A failure after a lock
   * timeout becomes `AttemptLockTimedOut`, which the retry policy matches.
   * @param effect - The caller's work.
   * @returns The attempt.
   */
  const attempt = <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<
    A,
    E | SqlError | AttemptLockTimedOut,
    Exclude<R, TransactionServices>
  > =>
    Effect.gen(function* configCommitAttempt() {
      const state = new TransactionState("config", client);
      const wait: AttemptWait = { blockers: new Set<number>() };

      const exit = yield* Effect.exit(
        runAtConfigState(state, configSetup(monitor, wait), effect)
      );

      if (
        Exit.isFailure(exit) &&
        state.lockTimedOut &&
        onlyLockTimeouts(exit.cause)
      ) {
        const blockers = [...wait.blockers];

        return yield* wait.waited === undefined
          ? new AttemptLockTimedOut({ blockers })
          : new AttemptLockTimedOut({ blockers, waited: wait.waited });
      }

      return yield* exit;
    });

  /**
   * The outermost config commit: attempts under the retry policy, then
   * `SchemaLockTimeout` naming the last attempt's blockers.
   * @param effect - The caller's work.
   * @param options - Optional retry delays.
   * @returns The caller's result after commit.
   */
  const outermost = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options: ConfigCommitOptions | undefined
  ): Effect.Effect<
    A,
    E | SqlError | SchemaLockTimeout,
    Exclude<R, TransactionServices>
  > => {
    const delays = options?.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const attempts = delays.length + 1;

    const policy = Schedule.jittered(retrySchedule(delays)).pipe(
      Schedule.tap(({ attempt: retry, duration }) =>
        Effect.logWarning(
          `Config commit attempt ${retry} of ${attempts} hit a lock timeout; retrying in ${Duration.format(duration)}`
        )
      )
    );

    return attempt(effect).pipe(
      Effect.retry({
        schedule: policy,
        while: (error) => error instanceof AttemptLockTimedOut,
      }),
      Effect.catchIf(
        (error): error is AttemptLockTimedOut =>
          error instanceof AttemptLockTimedOut,
        (timedOut) =>
          describeLockHolders(monitor, timedOut.blockers, timedOut.waited).pipe(
            Effect.flatMap((holders) =>
              Effect.fail(new SchemaLockTimeout({ attempts, holders }))
            )
          )
      )
    );
  };

  return Effect.fn("Transactions.configCommit")(
    function* configCommit<A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: ConfigCommitOptions
    ) {
      const current = yield* currentState;

      if (Option.isNone(current)) {
        return yield* outermost(effect, options);
      }

      return current.value.kind === "config"
        ? yield* provideJoined(current.value, effect)
        : yield* lockUpgradeRefused(current.value.kind);
    },
    (effect) => hygienic(effect)
  );
};

/**
 * Bumps `core.config_state` by one and announces the new revision with
 * `pg_notify('std_config', '<revision>')`, delivered on commit. Call once,
 * at the end of a config commit's work.
 * @param changeSetId - The change set this commit belongs to.
 * @returns The new configuration state.
 */
export const bumpRevision: (
  changeSetId: string
) => Effect.Effect<
  ConfigState,
  DatabaseError,
  CurrentTransaction | SqlClient.SqlClient
> = Effect.fn("ConfigCommit.bumpRevision")(
  function* bumpConfigRevision(changeSetId: string) {
    const transaction = yield* CurrentTransaction;

    if (transaction.kind !== "config") {
      return yield* Effect.die(
        new TransactionRefused({
          detail: "bumpRevision outside a config commit",
          reason: "nesting",
        })
      );
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`
        UPDATE core.config_state
        SET revision = revision + 1, change_set_id = ${changeSetId}::uuid
        RETURNING revision, change_set_id`;

    const next = yield* parseConfigState(rows);
    yield* sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${String(next.revision)})`;

    return next;
  },
  (effect) => hygienic(effect)
);
