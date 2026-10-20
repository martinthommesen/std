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
 * On lock timeout (SQLSTATE 55P03, from the `CONFIG_KEY` wait or a DDL lock
 * wait) the transaction rolls back and is retried after 0.5, 1, 2 and 4 s
 * with jitter, 5 attempts in total. Then it fails with `SchemaLockTimeout`
 * naming the sessions that blocked the last attempt.
 */
import type { PgClient } from "@effect/sql-pg";
import {
  Duration,
  Effect,
  Exit,
  Option,
  Random,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { hygienic } from "./errors.ts";
import type { DatabaseError, HygienicError } from "./errors.ts";
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

/** Each delay is multiplied by a random factor in `[1 - JITTER, 1 + JITTER]`. */
export const RETRY_JITTER = 0.2;

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

/**
 * The sessions that blocked a config commit, or that hold `CONFIG_KEY` when
 * no blocker was sampled.
 * @param monitor - A pooled client, outside the failed transaction.
 * @param pids - Blocking PIDs sampled while the attempt waited.
 * @returns The holders, by PID.
 */
export const describeLockHolders = (
  monitor: PgClient.PgClient,
  pids: readonly number[]
): Effect.Effect<readonly LockHolder[], SqlError> =>
  monitor
    .unsafe(HOLDERS_QUERY, [
      `{${pids.join(",")}}`,
      String(advisoryClassId(CONFIG_KEY)),
      String(advisoryObjectId(CONFIG_KEY)),
    ])
    .pipe(
      Effect.flatMap((rows) => decodeHolderRows(rows).pipe(Effect.orDie)),
      Effect.map((rows) =>
        rows.map((row) => ({
          applicationName: row.application_name,
          clientAddress: row.client_addr,
          locks: row.locks,
          pid: row.pid,
          state: row.state,
        }))
      )
    );

/**
 * Samples `pg_blocking_pids` of a waiting backend until interrupted.
 * @param monitor - A pooled client, outside the transaction.
 * @param pid - The backend of the config commit.
 * @param seen - Holds the blocking PIDs of the latest sample.
 * @returns An effect that runs until interrupted.
 */
const sampleBlockers = (
  monitor: PgClient.PgClient,
  pid: number,
  seen: Set<number>
): Effect.Effect<void> =>
  monitor
    .unsafe("SELECT unnest(pg_blocking_pids($1::int4)) AS pid", [pid])
    .pipe(
      Effect.flatMap((rows) => decodePidRows(rows)),
      Effect.tap((rows) =>
        Effect.sync(() => {
          seen.clear();

          for (const row of rows) {
            seen.add(row.pid);
          }
        })
      ),
      Effect.ignore,
      Effect.repeat(Schedule.spaced(BLOCKER_SAMPLE_INTERVAL)),
      Effect.asVoid
    );

const configSetup =
  (
    monitor: PgClient.PgClient,
    blockers: Set<number>
  ): TransactionSetup<ConfigState> =>
  (connection) =>
    Effect.gen(function* beginConfigCommitSetup() {
      yield* control(
        connection,
        `SET LOCAL lock_timeout = '${CONFIG_LOCK_TIMEOUT}'`
      );
      const pids = yield* control(connection, "SELECT pg_backend_pid() AS pid");
      const [backend] = yield* decodePidRows(pids).pipe(Effect.orDie);

      if (backend !== undefined) {
        yield* Effect.forkScoped(
          sampleBlockers(monitor, backend.pid, blockers)
        );
      }

      yield* control(connection, LOCK_CONFIG_KEY);
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

const jittered = (delay: Duration.Input): Effect.Effect<Duration.Duration> =>
  Random.nextBetween(1 - RETRY_JITTER, 1 + RETRY_JITTER).pipe(
    Effect.map((factor) =>
      Duration.millis(
        Math.round(Duration.toMillis(Duration.fromInputUnsafe(delay)) * factor)
      )
    )
  );

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
export const makeConfigCommit =
  (client: PgClient.PgClient, monitor: PgClient.PgClient): ConfigCommit =>
  <A, E, R>(effect: Effect.Effect<A, E, R>, options?: ConfigCommitOptions) => {
    const delays = options?.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const attempts = delays.length + 1;

    const attempt = (
      index: number
    ): Effect.Effect<
      A,
      E | SqlError | SchemaLockTimeout,
      Exclude<R, TransactionServices>
    > =>
      Effect.gen(function* configCommitAttempt() {
        const state = new TransactionState("config", client);
        const blockers = new Set<number>();

        const exit = yield* Effect.exit(
          runAtConfigState(state, configSetup(monitor, blockers), effect)
        );

        if (Exit.isSuccess(exit) || !state.lockTimedOut) {
          return yield* exit;
        }

        if (index + 1 >= attempts) {
          const holders = yield* describeLockHolders(monitor, [...blockers]);

          return yield* new SchemaLockTimeout({ attempts, holders });
        }

        const delay = yield* jittered(delays[index] ?? Duration.zero);
        yield* Effect.logWarning(
          `Config commit attempt ${index + 1} of ${attempts} hit a lock timeout; retrying in ${Duration.format(delay)}`
        );
        yield* Effect.sleep(delay);

        return yield* attempt(index + 1);
      });

    return hygienic(
      currentState.pipe(
        Effect.flatMap((current) =>
          Option.match(current, {
            onNone: () => attempt(0),
            onSome: (state) =>
              state.kind === "config"
                ? provideJoined(state, effect)
                : lockUpgradeRefused(state.kind),
          })
        )
      )
    );
  };

/**
 * Bumps `core.config_state` by one and announces the new revision with
 * `pg_notify('std_config', '<revision>')`, delivered on commit. Call once,
 * at the end of a config commit's work.
 * @param changeSetId - The change set this commit belongs to.
 * @returns The new configuration state.
 */
export const bumpRevision = (
  changeSetId: string
): Effect.Effect<
  ConfigState,
  DatabaseError,
  CurrentTransaction | SqlClient.SqlClient
> =>
  hygienic(
    Effect.gen(function* bumpConfigRevision() {
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
    })
  );
