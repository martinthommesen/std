/**
 * The debounced worker wake-up of the save pipeline (Contracts 4.1 step 11).
 *
 * A save never runs NOTIFY inside its transaction: a transaction that
 * notified takes a database-wide lock in `PreCommit_Notify` until after
 * commit, which would serialize the commits of all saves. Instead the save
 * registers `wakeWorkerAfterCommit`, and the process sends at most one
 * `NOTIFY std_worker` every 250 ms, on a pooled connection, after commit.
 */
import { PgClient } from "@effect/sql-pg";
import { Clock, Context, Duration, Effect, Layer } from "effect";
import type { Scope } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { CurrentTransaction } from "./transaction-context.ts";

/** The NOTIFY channel outbox workers listen on. */
export const WORKER_CHANNEL = "std_worker";

/** At most one wake-up per process per this interval. */
export const WAKE_UP_INTERVAL = Duration.millis(250);

const INTERVAL_MILLIS = Duration.toMillis(WAKE_UP_INTERVAL);

/** The worker wake-up service. */
export interface WorkerWakeupApi {
  /**
   * Requests a wake-up. Returns at once; the NOTIFY is sent in the
   * background, immediately or at the end of the current 250 ms window.
   */
  readonly wake: Effect.Effect<void>;
}

/** Sends debounced worker wake-ups. */
export class WorkerWakeup extends Context.Service<
  WorkerWakeup,
  WorkerWakeupApi
>()("@std/server/sql/wake-up/WorkerWakeup") {}

/**
 * Builds the debounced wake-up over the effect that sends one NOTIFY.
 * Pending sends are forked into the current scope and stop with it.
 * @param notify - Sends one wake-up.
 * @returns The service.
 */
export const makeWorkerWakeup: (
  notify: Effect.Effect<void, SqlError>
) => Effect.Effect<WorkerWakeupApi, never, Scope.Scope> = Effect.fn(
  "WorkerWakeup.make"
)(function* makeWakeup(notify: Effect.Effect<void, SqlError>) {
  const scope = yield* Effect.scope;
  let lastSent = Number.NEGATIVE_INFINITY;
  let pending = false;

  const send = Effect.gen(function* sendWakeup() {
    lastSent = yield* Clock.currentTimeMillis;
    pending = false;
    yield* notify;
  }).pipe(
    // Typed recovery only: a failed NOTIFY (a lost connection, a database
    // that is down) is logged and dropped, because a wake-up is best effort
    // and workers also poll (Contracts 4.6). Defects and interruption are
    // not caught.
    Effect.catchTag("SqlError", (failure) =>
      Effect.logWarning("Worker wake-up failed", failure)
    )
  );

  const schedule = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const wait = Math.max(0, lastSent + INTERVAL_MILLIS - now);

      return Effect.forkIn(
        Effect.sleep(Duration.millis(wait)).pipe(Effect.andThen(send)),
        scope
      );
    }),
    Effect.asVoid
  );

  const wake = Effect.suspend(() => {
    if (pending) {
      return Effect.void;
    }

    pending = true;

    return schedule;
  });

  return WorkerWakeup.of({ wake });
});

/**
 * The wake-up service on the pooled client; pending sends stop with the layer.
 */
export const WorkerWakeupLayer: Layer.Layer<
  WorkerWakeup,
  never,
  PgClient.PgClient
> = Layer.effect(
  WorkerWakeup,
  PgClient.PgClient.pipe(
    Effect.flatMap((client) =>
      makeWorkerWakeup(client.notify(WORKER_CHANNEL, ""))
    )
  )
);

/**
 * Registers a worker wake-up to be sent after the running transaction commits.
 * Nothing is sent inside the transaction, and nothing at all on rollback.
 */
export const wakeWorkerAfterCommit: Effect.Effect<
  void,
  never,
  WorkerWakeup | CurrentTransaction
> = Effect.gen(function* registerWakeup() {
  const wakeup = yield* WorkerWakeup;
  const transaction = yield* CurrentTransaction;

  yield* transaction.afterCommit(wakeup.wake);
});
