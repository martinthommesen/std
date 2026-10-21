/**
 * Observed lock state, for ordering the phases of a probe by what Postgres
 * reports instead of by sleeps: who blocks whom (`pg_blocking_pids`), who
 * holds or waits for `CONFIG_KEY` (`pg_locks`), and polling helpers.
 */
import {
  advisoryClassId,
  advisoryObjectId,
  CONFIG_KEY,
} from "@std/server/sql/locks";
import { decodeRows } from "@std/server/sql/rows";
import { Duration, Effect, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { now } from "./clock.ts";

/** How often observations are polled. */
export const POLL_INTERVAL = Duration.millis(10);

/** A wait that takes longer than this fails the probe. */
export const WAIT_LIMIT = Duration.minutes(2);

const decodeFlag = decodeRows(Schema.Struct({ flag: Schema.Boolean }));

const decodePids = decodeRows(Schema.Struct({ pid: Schema.Int }));

const flagOf = (rows: readonly unknown[]) =>
  decodeFlag(rows).pipe(Effect.map(([row]) => row?.flag === true));

/**
 * Polls `check` every `POLL_INTERVAL` until it returns `true` or `limit` has
 * passed. A running check is never interrupted, so no query is cut off.
 * @param check - The condition.
 * @param limit - How long to keep polling.
 * @returns Whether the condition held.
 */
export const pollFor = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  limit: Duration.Input
): Effect.Effect<boolean, E, R> =>
  check.pipe(
    Effect.repeat({
      schedule: Schedule.max([
        Schedule.spaced(POLL_INTERVAL),
        Schedule.during(limit),
      ]),
      until: (done: boolean) => done,
    })
  );

/**
 * Polls `check` until it returns `true`; dies after `WAIT_LIMIT`.
 * @param check - The condition.
 * @returns Completes once the condition holds.
 */
export const waitFor = <E, R>(
  check: Effect.Effect<boolean, E, R>
): Effect.Effect<void, E, R> =>
  pollFor(check, WAIT_LIMIT).pipe(
    Effect.flatMap((done) =>
      done ? Effect.void : Effect.die(new Error("probe wait timed out"))
    )
  );

/**
 * Whether `blocker` is among the sessions `waiter` waits for.
 * @param waiter - A backend PID.
 * @param blocker - Another backend PID.
 * @returns `true` while `waiter` waits for a lock `blocker` holds or queues ahead for.
 */
export const isBlockedBy = (waiter: number, blocker: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`SELECT ${blocker}::int4 = ANY(pg_blocking_pids(${waiter}::int4)) AS flag`
    ),
    Effect.flatMap(flagOf)
  );

/**
 * Whether `pid` waits for any lock.
 * @param pid - A backend PID.
 * @returns `true` while it waits.
 */
export const isWaiting = (pid: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`SELECT cardinality(pg_blocking_pids(${pid}::int4)) > 0 AS flag`
    ),
    Effect.flatMap(flagOf)
  );

const CONFIG_KEY_FILTER = `locktype = 'advisory'
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND classid = ${String(advisoryClassId(CONFIG_KEY))}::oid
  AND objid = ${String(advisoryObjectId(CONFIG_KEY))}::oid`;

/**
 * Whether `pid` holds `CONFIG_KEY` (shared or exclusive).
 * @param pid - A backend PID.
 * @returns `true` while it holds it.
 */
export const holdsConfigKey = (pid: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `SELECT count(*) > 0 AS flag FROM pg_locks WHERE ${CONFIG_KEY_FILTER} AND granted AND pid = $1`,
        [pid]
      )
    ),
    Effect.flatMap(flagOf)
  );

/**
 * Sessions waiting for `CONFIG_KEY` shared (STD requests in `begin_request()`)
 * whose wait `blocker` causes.
 * @param blocker - The backend holding or queued for `CONFIG_KEY` exclusive.
 * @returns Their PIDs.
 */
export const configKeyWaitersBlockedBy = (blocker: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `SELECT pid FROM pg_locks
         WHERE ${CONFIG_KEY_FILTER} AND NOT granted AND mode = 'ShareLock'
           AND $1::int4 = ANY(pg_blocking_pids(pid))`,
        [blocker]
      )
    ),
    Effect.flatMap(decodePids),
    Effect.map((rows) => rows.map((row) => row.pid))
  );

/**
 * Lets `waiter` wait on `blocker` for `holdMs`, then runs `release`. The wait
 * is measured from when it is first observed; if `waiter` stops waiting on
 * `blocker` earlier (its lock request timed out), `release` runs at once.
 * @param waiter - The backend that will wait.
 * @param blocker - The backend holding the lock.
 * @param holdMs - How long to let the wait last.
 * @param release - Ends the blocker's transaction.
 * @returns How long the wait was observed before the release.
 */
export const releaseAfterWait = <E, R>(
  waiter: number,
  blocker: number,
  holdMs: number,
  release: Effect.Effect<unknown, E, R>
) =>
  Effect.gen(function* holdThenRelease() {
    yield* waitFor(isBlockedBy(waiter, blocker));
    const waitingSince = yield* now;
    yield* pollFor(
      isBlockedBy(waiter, blocker).pipe(Effect.map((blocked) => !blocked)),
      Duration.millis(holdMs)
    );
    const observedMs = (yield* now) - waitingSince;
    yield* release;

    return observedMs;
  });
