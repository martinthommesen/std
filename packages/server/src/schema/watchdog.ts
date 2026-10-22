/**
 * The watchdog of follow-up steps (Contracts 1.5, 8.7). Concurrent index
 * steps run with `lock_timeout = 0` and keep no transaction open, so a
 * build that waits for another session's transaction or snapshot can wait
 * indefinitely. While a step runs, the watchdog looks at the coordinator's
 * backend every `watchdogPoll`; once it has waited longer than
 * `watchdogAfter` (a waiting phase of `pg_stat_progress_create_index`, or
 * a lock wait `pg_blocking_pids` reports), it writes the PIDs it waits for
 * into the step's `last_error`, where `std schema status` shows them. It
 * never cancels anything: cancelling is an operator decision, through
 * `std schema abandon`.
 *
 * It runs on the pool, because the coordinator's connection is busy with
 * the step.
 */
import { Clock, Duration, Effect, Ref, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { decodeRows } from "../sql/rows.ts";
import { RecoverySettings } from "./recovery-settings.ts";

/** What the watchdog sees of a backend. */
export interface BackendWait {
  /** The build's phase, or null when no build runs on the backend. */
  readonly phase: string | null;
  /** PIDs the backend waits for. */
  readonly blockers: readonly number[];
}

const decodeWait = decodeRows(
  Schema.Struct({
    blockers: Schema.String,
    phase: Schema.NullOr(Schema.String),
  })
);

/**
 * What a backend is waiting for now.
 *
 * @param backendPid - The backend running a step.
 * @returns Its build phase and the PIDs blocking it.
 */
export const backendWait = Effect.fn("Schema.backendWait")(
  function* backendWait(backendPid: number) {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* sql
      .unsafe(
        `SELECT p.phase, coalesce(array_to_string(pg_blocking_pids($1::int4), ','), '') AS blockers
       FROM (SELECT $1::int4 AS pid) AS b
       LEFT JOIN pg_stat_progress_create_index AS p ON p.pid = b.pid`,
        [String(backendPid)]
      )
      .pipe(Effect.flatMap(decodeWait));

    return {
      blockers:
        row === undefined || row.blockers === ""
          ? []
          : row.blockers.split(",").map(Number),
      phase: row?.phase ?? null,
    } satisfies BackendWait;
  }
);

/**
 * Whether a backend is in a waiting phase.
 *
 * @param wait - What it waits for.
 * @returns True while it waits for other sessions.
 */
export const isWaiting = (wait: BackendWait): boolean =>
  wait.blockers.length > 0 || (wait.phase?.startsWith("waiting") ?? false);

/**
 * The report the watchdog writes.
 *
 * @param wait - What the backend waits for.
 * @param waitedMs - How long it has waited.
 * @returns The text.
 */
export const watchdogReport = (wait: BackendWait, waitedMs: number): string => {
  const phase = wait.phase === null ? "" : ` in phase "${wait.phase}"`;

  const pids =
    wait.blockers.length === 0 ? "(none reported)" : wait.blockers.join(", ");

  return `Watchdog: waiting ${Math.round(waitedMs / 1000)} s${phase} for PIDs ${pids}; nothing is cancelled (end the blocking sessions or run std schema abandon)`;
};

interface WatchState {
  readonly since: number | null;
  readonly reported: string | null;
}

/**
 * Watches one running step until interrupted.
 *
 * @param stepId - The step's row.
 * @param backendPid - The coordinator's backend.
 * @returns An effect that runs until interrupted; failures of a pass are
 *   logged and the watch goes on.
 */
export const watchStep = Effect.fn("Schema.watchStep")(function* watchStep(
  stepId: string,
  backendPid: number
) {
  const settings = yield* RecoverySettings;
  const sql = yield* SqlClient.SqlClient;
  const after = Duration.toMillis(settings.watchdogAfter);

  const state = yield* Ref.make<WatchState>({ reported: null, since: null });

  const pass = Effect.gen(function* watchPass() {
    const wait = yield* backendWait(backendPid);
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(state);

    if (!isWaiting(wait)) {
      yield* Ref.set(state, { reported: null, since: null });

      return;
    }

    const since = previous.since ?? now;
    const blockers = wait.blockers.join(",");

    if (now - since >= after && previous.reported !== blockers) {
      yield* sql.unsafe(
        `UPDATE core."schema_change_step" SET last_error = $2::text WHERE id = $1::uuid AND state = 'running'`,
        [stepId, watchdogReport(wait, now - since)]
      );
      yield* Effect.logWarning("Schema change step waits", {
        blockers: wait.blockers,
        phase: wait.phase,
        stepId,
      });
      yield* Ref.set(state, { reported: blockers, since });

      return;
    }

    yield* Ref.set(state, { ...previous, since });
  }).pipe(
    Effect.tapError((failure) =>
      Effect.logWarning("Watchdog pass failed", failure)
    ),
    Effect.ignore
  );

  return yield* pass.pipe(
    Effect.repeat(Schedule.spaced(settings.watchdogPoll))
  );
});
