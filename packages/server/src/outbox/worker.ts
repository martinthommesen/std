/**
 * The outbox worker (Contracts 4.6, 4.7; decision 0023).
 *
 * A pass loads the latest configuration and, for every active, enabled
 * subscription that a `DeliveryHandler` serves, claims up to `batchSize`
 * due deliveries (`claimDeliveries`: the 4.6 claim predicate with
 * `FOR UPDATE SKIP LOCKED`, a new `lease_token` per claim, committed before
 * any effect starts) and runs them, all at once: one claim holds at most one
 * row per record, because a record's later versions wait for the earlier
 * one. Deliveries of subscriptions no handler serves are never claimed.
 *
 * One delivery:
 *
 * 1. The payload is built for the subscription's identity (4.5); an
 *    identity that is missing or inactive fails the attempt.
 * 2. A `record` effect runs in one request transaction with the payload
 *    reads before it and the fenced `done` update after it: its writes and
 *    `done` commit together, or not at all. An `external` effect runs
 *    outside any transaction, then the fenced `done` commits on its own.
 * 3. The effect is interrupted when the claim's effect deadline passes:
 *    `effectTimeout` after the worker started the claim, so before
 *    `lease_until`, which the database sets `effectTimeout + leaseMargin`
 *    after the claim began.
 * 4. A fenced update that finds the lease lost (`LeaseLost`) discards the
 *    result; in a delivery transaction the whole transaction rolls back. Any
 *    other failure is recorded with the fenced failure update: `pending`
 *    with backoff (10 s doubling to 1 h, minus up to 20 %), or `dead` after
 *    `max_attempts` claims. An interrupted worker records nothing: the
 *    lease expires and the next claim counts it as an attempt.
 *
 * Between passes the worker waits for a wake-up (LISTEN `std_worker`, sent
 * by saves after commit, debounced, 4.1 step 11) or the poll interval,
 * whichever comes first; while a pass claimed something it runs the next at
 * once. Wake-ups only wake: polling alone is enough for correctness.
 *
 * Housekeeping, every `housekeepingInterval`: `done` rows whose
 * `finished_at` is more than 7 days old are deleted, in batches; `dead`
 * rows stay. The dead-delivery gauge is refreshed.
 */
import { PgClient } from "@effect/sql-pg";
import type { SubscriptionDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  Cause,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";

import { Actor, effectiveRoles, readUserRoles } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import type { ChangeCause } from "../records/change-entry.ts";
import { RuleWriteAccess } from "../records/write-access-rules.ts";
import { LISTEN_RETRY } from "../sql/config-listener.ts";
import { sqlStateOf } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import { Transactions } from "../sql/transactions.ts";
import { WORKER_CHANNEL } from "../sql/wake-up.ts";
import { claimDeliveries, markDone, markFailed } from "./delivery-claims.ts";
import type { ClaimedDelivery } from "./delivery-claims.ts";
import { DeliveryHandlers, effectFor } from "./delivery-effects.ts";
import type { Delivery, DeliveryEffect } from "./delivery-effects.ts";
import { DeliveryFailed } from "./delivery-failed.ts";
import {
  payloadOf,
  PayloadUnreadable,
  readEntries,
} from "./delivery-payload.ts";
import {
  deliveriesDead,
  deliveriesDone,
  deliveriesFailed,
  deliveriesLeaseLost,
  refreshDeadGauge,
} from "./metrics.ts";

/** How the worker runs. */
export interface WorkerSettingsValues {
  /** Rows claimed per subscription and pass. */
  readonly batchSize: number;
  /** How long one delivery's effect may run before it is interrupted. */
  readonly effectTimeout: Duration.Duration;
  /** How much longer than the effect timeout a lease lasts. */
  readonly leaseMargin: Duration.Duration;
  /** The longest wait between passes without a wake-up. */
  readonly pollInterval: Duration.Duration;
  /** How often old `done` rows are deleted and the dead gauge refreshed. */
  readonly housekeepingInterval: Duration.Duration;
  /** How many subscriptions one pass serves at once. */
  readonly subscriptionConcurrency: number;
}

/** The defaults [judgment, decision 0023]. */
export const DEFAULT_WORKER_SETTINGS: WorkerSettingsValues = {
  batchSize: 16,
  effectTimeout: Duration.seconds(60),
  housekeepingInterval: Duration.minutes(1),
  leaseMargin: Duration.seconds(30),
  pollInterval: Duration.seconds(2),
  subscriptionConcurrency: 4,
};

/** `done` rows are deleted this long after they finished (Contracts 4.6). */
export const DONE_RETENTION = Duration.days(7);

/** Rows one retention statement deletes at most. */
export const RETENTION_BATCH = 1000;

/** The worker's settings. */
export class WorkerSettings extends Context.Service<
  WorkerSettings,
  WorkerSettingsValues
>()("@std/server/outbox/worker/WorkerSettings") {
  /**
   * Fixed settings, for tests and embedding.
   *
   * @param overrides - Settings that differ from the defaults.
   * @returns The layer.
   */
  static readonly layerOf = (
    overrides: Partial<WorkerSettingsValues> = {}
  ): Layer.Layer<WorkerSettings> =>
    Layer.succeed(
      WorkerSettings,
      WorkerSettings.of({ ...DEFAULT_WORKER_SETTINGS, ...overrides })
    );

  /**
   * `STD_WORKER_BATCH_SIZE`, `STD_WORKER_EFFECT_TIMEOUT`,
   * `STD_WORKER_POLL_INTERVAL` and `STD_WORKER_CONCURRENCY` (subscriptions
   * served at once), each with its default.
   */
  static readonly fromEnv: Layer.Layer<WorkerSettings, Config.ConfigError> =
    Layer.effect(
      WorkerSettings,
      Effect.gen(function* readWorkerSettings() {
        const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

        const batchSize = yield* Config.schema(
          positive,
          "STD_WORKER_BATCH_SIZE"
        ).pipe(Config.withDefault(DEFAULT_WORKER_SETTINGS.batchSize));

        const effectTimeout = yield* Config.Duration(
          "STD_WORKER_EFFECT_TIMEOUT"
        ).pipe(Config.withDefault(DEFAULT_WORKER_SETTINGS.effectTimeout));

        const pollInterval = yield* Config.Duration(
          "STD_WORKER_POLL_INTERVAL"
        ).pipe(Config.withDefault(DEFAULT_WORKER_SETTINGS.pollInterval));

        const subscriptionConcurrency = yield* Config.schema(
          positive,
          "STD_WORKER_CONCURRENCY"
        ).pipe(
          Config.withDefault(DEFAULT_WORKER_SETTINGS.subscriptionConcurrency)
        );

        return WorkerSettings.of({
          ...DEFAULT_WORKER_SETTINGS,
          batchSize,
          effectTimeout,
          pollInterval,
          subscriptionConcurrency,
        });
      })
    );
}

/**
 * The lease a claim takes: the effect timeout plus the margin, so the
 * worker interrupts the effect before another worker can claim the row.
 *
 * @param settings - The worker's settings.
 * @returns The lease.
 */
export const leaseOf = (settings: WorkerSettingsValues): Duration.Duration =>
  Duration.sum(settings.effectTimeout, settings.leaseMargin);

/** A subscription and the effect that serves it. */
interface Served {
  readonly subscription: SubscriptionDefinition;
  readonly effect: DeliveryEffect;
}

/** How one attempt ended. */
export type AttemptOutcome =
  | "done"
  | "pending"
  | "dead"
  | "lease-lost"
  | "expired"
  | "interrupted"
  | "unrecorded";

const IDENTITY_UNAVAILABLE =
  "The subscription's identity is missing or inactive.";

/**
 * The subscription's identity as an actor: its roles now. A missing or
 * inactive identity fails the attempt (decision 0013, open items).
 */
const identityOf = Effect.fn("Outbox.identity")(function* identityOf(
  snapshot: ConfigSnapshot,
  identityId: DefinitionId
) {
  const users = yield* readUserRoles(snapshot, [identityId]);
  const user = users.get(identityId);

  if (user === undefined || !user.active) {
    return yield* new DeliveryFailed({ reason: IDENTITY_UNAVAILABLE });
  }

  const actor: ActingUser = {
    roleIds: effectiveRoles(snapshot, true, user.roleIds),
    userId: identityId,
  };

  return actor;
});

/**
 * Builds what an effect receives, inside a request transaction: the
 * identity, and the payload from history under the transaction's
 * configuration.
 */
const prepare = Effect.fn("Outbox.prepareDelivery")(function* prepare(
  subscription: SubscriptionDefinition,
  claimed: ClaimedDelivery
) {
  const snapshot = yield* (yield* Catalog).current;
  const actor = yield* identityOf(snapshot, subscription.identityId);
  const { timeZone } = yield* InstanceSettings;
  const now = yield* Clock.currentTimeMillis;
  const entries = yield* readEntries(claimed.recordId, claimed.recordVersion);

  if (entries.at(-1)?.changeId !== claimed.changeId) {
    return yield* new PayloadUnreadable({
      reason: `The change entry ${claimed.changeId} is not the record's entry at version ${claimed.recordVersion}.`,
    });
  }

  const payload = payloadOf(snapshot, actor, claimed.recordId, entries, {
    me: actor.userId,
    now,
    timeZone,
  });

  if (payload instanceof PayloadUnreadable) {
    return yield* payload;
  }

  const cause: ChangeCause = {
    kind: "after_commit",
    parentChangeId: claimed.changeId,
    subscriptionId: subscription.id,
  };

  const delivery: Delivery = {
    attempts: claimed.attempts,
    cause,
    changeId: claimed.changeId,
    deliveryId: claimed.id,
    payload,
    recordId: claimed.recordId,
    recordVersion: claimed.recordVersion,
    snapshot,
    subscription,
  };

  return { actor, delivery };
});

const TaggedSchema = Schema.Struct({ _tag: Schema.String });

const isTagged = Schema.is(TaggedSchema);

/**
 * The tag of an attempt's typed failure, if it has one.
 *
 * @param cause - The attempt's failure.
 * @returns The `_tag`, or undefined for a defect or an untagged failure.
 */
const failureTag = (cause: Cause.Cause<unknown>): string | undefined => {
  const error = Cause.findErrorOption(cause);

  return Option.isSome(error) && isTagged(error.value)
    ? error.value._tag
    : undefined;
};

/**
 * The `last_error` of a failed attempt: the error's tag and, for the
 * failures STD words itself, their fixed text. Never a value or a secret
 * (4.3): defects are only logged.
 *
 * @param cause - The attempt's failure.
 * @param timeout - The effect timeout, for the message.
 * @returns The text.
 */
const describeFailure = (
  cause: Cause.Cause<unknown>,
  timeout: Duration.Duration
): string => {
  const error = Cause.findErrorOption(cause);

  if (Option.isNone(error)) {
    return "Defect: the attempt died; see the worker log.";
  }

  const failure = error.value;

  if (
    failure instanceof DeliveryFailed ||
    failure instanceof PayloadUnreadable
  ) {
    return `${failure._tag}: ${failure.reason}`;
  }

  const tag = failureTag(cause);

  if (tag === "TimeoutError") {
    return `TimeoutError: the effect did not finish within ${Duration.toMillis(timeout)} ms.`;
  }

  if (tag === "DatabaseError" && Predicate.hasProperty(failure, "sqlState")) {
    return `DatabaseError: SQLSTATE ${String(failure.sqlState)}`;
  }

  return tag ?? "Failure: the effect failed.";
};

const isLeaseLost = (cause: Cause.Cause<unknown>): boolean =>
  failureTag(cause) === "LeaseLost";

/**
 * The counter of a recorded failure.
 *
 * @param outcome - How the failure update ended.
 * @returns The counter to bump.
 */
const counterOf = (outcome: AttemptOutcome) => {
  if (outcome === "dead") {
    return deliveriesDead;
  }

  return outcome === "pending" ? deliveriesFailed : deliveriesLeaseLost;
};

/**
 * Runs one claimed delivery and records its outcome.
 *
 * @param served - The subscription and its effect.
 * @param claimed - The claimed row.
 * @param deadline - When the effect must be interrupted (epoch ms).
 * @returns How the attempt ended.
 */
export const runDelivery = Effect.fn("Outbox.runDelivery")(
  function* runDelivery(
    served: Served,
    claimed: ClaimedDelivery,
    deadline: number
  ) {
    const settings = yield* WorkerSettings;
    const { request } = yield* Transactions;
    const now = yield* Clock.currentTimeMillis;
    const remaining = deadline - now;

    if (remaining <= 0) {
      // Too late to start: the lease expires and the next claim retries.
      return "expired" satisfies AttemptOutcome;
    }

    const { effect, subscription } = served;

    const attempt =
      effect.kind === "record"
        ? request(
            Effect.gen(function* recordDelivery() {
              const { actor, delivery } = yield* prepare(subscription, claimed);

              yield* effect
                .run(delivery)
                .pipe(
                  Effect.timeout(remaining),
                  Effect.provide(RuleWriteAccess),
                  Effect.provideService(Actor, actor)
                );

              // The last statement: the effect's writes and `done` commit
              // together, or roll back together on a lost lease.
              yield* markDone(claimed);
            })
          )
        : Effect.gen(function* externalDelivery() {
            const { delivery } = yield* request(prepare(subscription, claimed));
            const left = deadline - (yield* Clock.currentTimeMillis);

            yield* effect.run(delivery).pipe(Effect.timeout(Math.max(left, 0)));
            yield* markDone(claimed);
          });

    const exit = yield* Effect.exit(attempt);

    if (Exit.isSuccess(exit)) {
      yield* Metric.update(deliveriesDone, 1);

      return "done" satisfies AttemptOutcome;
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      return "interrupted" satisfies AttemptOutcome;
    }

    if (isLeaseLost(exit.cause)) {
      yield* Metric.update(deliveriesLeaseLost, 1);
      yield* Effect.logWarning(
        `Outbox delivery ${claimed.id}: the lease was lost; the result is discarded`
      );

      return "lease-lost" satisfies AttemptOutcome;
    }

    if (Option.isNone(Cause.findErrorOption(exit.cause))) {
      yield* Effect.logError(
        `Outbox delivery ${claimed.id} died`,
        Cause.pretty(exit.cause)
      );
    }

    const recorded = yield* markFailed(claimed, {
      error: describeFailure(exit.cause, settings.effectTimeout),
      maxAttempts: subscription.maxAttempts,
    }).pipe(
      Effect.map((outcome): AttemptOutcome => outcome),
      Effect.catchTag("LeaseLost", () =>
        Effect.succeed<AttemptOutcome>("lease-lost")
      ),
      Effect.catchTag("DatabaseError", (failure) =>
        Effect.logWarning(
          `Outbox delivery ${claimed.id}: the failure was not recorded (SQLSTATE ${failure.sqlState})`
        ).pipe(Effect.as<AttemptOutcome>("unrecorded"))
      )
    );

    yield* Metric.update(counterOf(recorded), 1);

    return recorded;
  }
);

/**
 * Claims one batch of a subscription's due deliveries and runs them.
 *
 * @param served - The subscription and its effect.
 * @returns How many rows were claimed.
 */
const serveSubscription = Effect.fn("Outbox.serveSubscription")(
  function* serveSubscription(served: Served) {
    const settings = yield* WorkerSettings;
    const started = yield* Clock.currentTimeMillis;

    const claimed = yield* claimDeliveries({
      deadLetter: served.subscription.deadLetter,
      lease: leaseOf(settings),
      limit: settings.batchSize,
      maxAttempts: served.subscription.maxAttempts,
      subscriptionId: served.subscription.id,
    });

    const deadline = started + Duration.toMillis(settings.effectTimeout);

    // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
    yield* Effect.forEach(
      claimed,
      (row) => runDelivery(served, row, deadline),
      { concurrency: "unbounded", discard: true }
    );

    return claimed.length;
  }
);

/**
 * The subscriptions a worker serves under a configuration: active, enabled
 * and served by a handler.
 *
 * @param snapshot - The configuration.
 * @param handlers - The worker's handlers.
 * @returns Each with its effect.
 */
const servedSubscriptions = (
  snapshot: ConfigSnapshot,
  handlers: DeliveryHandlers["Service"]
): readonly Served[] =>
  snapshot.subscriptions().flatMap((subscription) => {
    if (subscription.state !== "active" || !subscription.enabled) {
      return [];
    }

    const effect = effectFor(handlers, subscription, snapshot);

    return effect === undefined ? [] : [{ effect, subscription }];
  });

/**
 * One pass over every served subscription. Database failures of a claim
 * are logged; the next pass tries again.
 *
 * @returns How many rows the pass claimed.
 */
export const workerPass = Effect.fn("Outbox.workerPass")(
  function* workerPass() {
    const settings = yield* WorkerSettings;
    const handlers = yield* DeliveryHandlers;
    const snapshot = yield* (yield* Catalog).refresh;

    // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
    const counts = yield* Effect.forEach(
      servedSubscriptions(snapshot, handlers),
      (served) =>
        serveSubscription(served).pipe(
          Effect.catchTag("DatabaseError", (failure) =>
            Effect.logWarning(
              `Outbox claim for subscription ${served.subscription.id} failed (SQLSTATE ${failure.sqlState})`
            ).pipe(Effect.as(0))
          )
        ),
      { concurrency: settings.subscriptionConcurrency }
    );

    return counts.reduce((sum, count) => sum + count, 0);
  },
  Effect.catchTag("DatabaseError", (failure) =>
    Effect.logWarning(
      `Outbox pass failed (SQLSTATE ${failure.sqlState}); retrying after the poll interval`
    ).pipe(Effect.as(0))
  )
);

const decodeDeleted = decodeRows(Schema.Struct({ id: Schema.String }));

/**
 * Deletes `done` rows that finished more than 7 days ago, in batches of
 * `RETENTION_BATCH`; `dead` rows stay (Contracts 4.6).
 *
 * @returns How many rows were deleted.
 */
export const deleteOldDeliveries = Effect.fn("Outbox.deleteOldDeliveries")(
  function* deleteOldDeliveries() {
    const { request } = yield* Transactions;
    let total = 0;

    for (;;) {
      const deleted = yield* request(
        SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) =>
            sql.unsafe(
              `DELETE FROM core.delivery
               WHERE id IN (
                 SELECT id FROM core.delivery
                 WHERE status = 'done' AND finished_at < now() - $1::interval
                 ORDER BY finished_at
                 LIMIT $2::int8
                 FOR UPDATE SKIP LOCKED)
               RETURNING id::text AS id`,
              [
                `${Duration.toMillis(DONE_RETENTION)} milliseconds`,
                String(RETENTION_BATCH),
              ]
            )
          ),
          Effect.flatMap(decodeDeleted)
        )
      );

      total += deleted.length;

      if (deleted.length < RETENTION_BATCH) {
        return total;
      }
    }
  }
);

/**
 * Deletes old `done` rows and refreshes the dead gauge; failures are
 * logged.
 */
const housekeeping = Effect.gen(function* housekeep() {
  yield* deleteOldDeliveries();
  yield* refreshDeadGauge();
}).pipe(
  Effect.catchTag("DatabaseError", (failure) =>
    Effect.logWarning(
      `Outbox housekeeping failed (SQLSTATE ${failure.sqlState})`
    )
  )
);

/**
 * The wake-ups of this process: one when LISTEN is (re-)established, since
 * notifications sent while disconnected are lost, then one per
 * notification. A lost connection is logged and re-listened with
 * `LISTEN_RETRY`; the stream never fails.
 */
export const workerWakeups: Stream.Stream<true, never, PgClient.PgClient> =
  Stream.unwrap(
    PgClient.PgClient.pipe(
      Effect.map((client) =>
        Stream.unwrap(
          client
            .listen(WORKER_CHANNEL)
            .pipe(
              Effect.map((queue) =>
                Stream.concat(
                  Stream.succeed<true>(true),
                  Stream.fromQueue(queue).pipe(Stream.as<true>(true))
                )
              )
            )
        ).pipe(
          Stream.tapError((failure) =>
            Effect.logWarning(
              `Outbox worker lost its LISTEN connection (SQLSTATE ${sqlStateOf(failure)}); reconnecting`
            )
          ),
          Stream.retry(LISTEN_RETRY),
          Stream.orDie
        )
      )
    )
  );

/**
 * The worker: passes, wake-ups and polling, and housekeeping, until
 * interrupted. Fork it into a scope (`OutboxWorkerLayer`).
 */
export const runWorker = Effect.gen(function* runOutboxWorker() {
  const settings = yield* WorkerSettings;
  const wake = yield* Queue.sliding<true>(1);

  yield* workerWakeups.pipe(
    Stream.runForEach((signal) => Queue.offer(wake, signal)),
    Effect.forkScoped
  );

  yield* housekeeping.pipe(
    Effect.andThen(Effect.sleep(settings.housekeepingInterval)),
    Effect.forever,
    Effect.forkScoped
  );

  const step = Effect.gen(function* workerStep() {
    if ((yield* workerPass()) > 0) {
      return;
    }

    yield* Queue.take(wake).pipe(Effect.timeoutOption(settings.pollInterval));
  });

  return yield* Effect.forever(step);
});

/**
 * The worker as a layer: it runs in the layer's scope and stops with it.
 * The process provides the handlers, the record service's hooks and
 * password handling (for record effects), the catalog and the SQL layer.
 */
export const OutboxWorkerLayer = Layer.effectDiscard(
  Effect.forkScoped(runWorker)
);
