/**
 * The outbox worker (Contracts 4.6, 4.7; decision 0023).
 *
 * A pass loads the latest configuration to find the subscriptions a
 * `DeliveryHandler` serves. For each, one claim transaction (a request
 * transaction: `begin_request()` under `CONFIG_KEY` shared, Contracts 1.3)
 * resolves the subscription again from its own snapshot, so a disable,
 * retire or policy change committed after the pass's refresh is honoured;
 * only an active, enabled, served subscription is claimed for, with its
 * current dead-letter policy and `max_attempts`. The claim (with `FOR UPDATE SKIP LOCKED`,
 * and a new `lease_token`) commits before any effect starts, and
 * its rows run at once: one claim holds at most one row per record.
 *
 * One delivery has one deadline, `effectTimeout` after the worker started
 * the claim, which is before `lease_until` by at least `leaseMargin`. The
 * deadline covers everything before the effect too:
 *
 * 1. Preparation, in a request transaction (for a `record` effect, the
 *    delivery transaction itself): the subscription is resolved once more
 *    from that transaction's snapshot. Disabled, retired, no longer served,
 *    or served by another kind of effect: the effect is not run and the
 *    claim is released (`releaseClaim`, not counted as an attempt). Else
 *    the effect runs with the snapshot's subscription, so its current
 *    identity, whose roles filter the payload (4.5); a missing or inactive
 *    identity fails the attempt.
 * 2. Once the deadline has passed, the handler is never invoked, however
 *    long acquiring a connection or preparing took: the attempt is treated
 *    as a lost lease (nothing recorded; the lease expires and the next
 *    claim counts it). Otherwise the effect gets exactly the time left and
 *    is interrupted at the deadline (`TimeoutError`, recorded as a failure
 *    within the margin).
 * 3. A `record` effect's writes and the fenced `done` commit in one
 *    transaction, or not at all; an `external` effect runs outside any
 *    transaction, then `done` commits on its own.
 * 4. A fenced update that finds the lease lost (`LeaseLost`) discards the
 *    result. Any other failure is recorded: `pending` with backoff (10 s
 *    doubling to 1 h, minus up to 20 %), or `dead` after `max_attempts`
 *    claims. An interrupted worker records nothing.
 *
 * Between passes the worker waits for a wake-up (LISTEN `std_worker`, sent
 * by saves after commit, debounced, 4.1 step 11) or the poll interval,
 * whichever comes first; while a pass claimed something it runs the next at
 * once. Wake-ups only wake: polling alone is enough for correctness.
 *
 * Housekeeping, every `housekeepingInterval`: `done` rows whose
 * `finished_at` is more than 7 days old are deleted, in batches; `dead`
 * rows stay. The dead-delivery gauge is refreshed.
 *
 * `WorkerProbes` lets tests observe and delay the worker at fixed points;
 * it does nothing in production.
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
  Ref,
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
import { AttemptRefused } from "./attempt-refused.ts";
import {
  claimInTransaction,
  markDone,
  markFailed,
  releaseClaim,
} from "./delivery-claims.ts";
import type { ClaimedDelivery } from "./delivery-claims.ts";
import { DeliveryHandlers, effectFor } from "./delivery-effects.ts";
import type { Delivery, DeliveryEffect } from "./delivery-effects.ts";
import { DeliveryFailed } from "./delivery-failed.ts";
import {
  payloadOf,
  PayloadUnreadable,
  readEntries,
  readFieldOrigins,
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
  /**
   * How long one delivery may take from the start of its claim, preparation
   * included, before its effect is interrupted.
   */
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

/** What the worker loop reports when it is about to wait. */
export interface IdleState {
  /** Wake-ups received so far (the first when LISTEN is established). */
  readonly wakeSignals: number;
  /** Wake-ups queued and not yet taken (0 or 1). */
  readonly pendingWakeups: number;
}

/** Points where tests observe or delay the worker. */
export interface WorkerProbesApi {
  /** Before a claimed delivery acquires its transaction. */
  readonly beforeAttempt: (claimed: ClaimedDelivery) => Effect.Effect<void>;
  /** At the start of preparation, inside its transaction. */
  readonly preparing: (claimed: ClaimedDelivery) => Effect.Effect<void>;
  /** Before the loop waits for a wake-up or the poll interval. */
  readonly idle: (state: IdleState) => Effect.Effect<void>;
}

/** The worker's probes: no-ops unless a test provides its own. */
export const WorkerProbes = Context.Reference<WorkerProbesApi>(
  "@std/server/outbox/worker/WorkerProbes",
  {
    defaultValue: () => ({
      beforeAttempt: () => Effect.void,
      idle: () => Effect.void,
      preparing: () => Effect.void,
    }),
  }
);

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
export interface Served {
  readonly subscription: SubscriptionDefinition;
  readonly effect: DeliveryEffect;
}

/**
 * A subscription as a configuration serves it: active, enabled and served
 * by a handler, with that handler's effect.
 *
 * @param snapshot - The configuration.
 * @param handlers - The worker's handlers.
 * @param subscriptionId - The subscription.
 * @returns It and its effect, or undefined when it is not served.
 */
const resolveServed = (
  snapshot: ConfigSnapshot,
  handlers: DeliveryHandlers["Service"],
  subscriptionId: DefinitionId
): Served | undefined => {
  const subscription = snapshot
    .subscriptions()
    .find((candidate) => candidate.id === subscriptionId);

  if (
    subscription === undefined ||
    subscription.state !== "active" ||
    !subscription.enabled
  ) {
    return undefined;
  }

  const effect = effectFor(handlers, subscription, snapshot);

  return effect === undefined ? undefined : { effect, subscription };
};

/** How one attempt ended. */
export type AttemptOutcome =
  | "done"
  | "pending"
  | "dead"
  | "lease-lost"
  | "expired"
  | "released"
  | "interrupted"
  | "unrecorded";

const LEASE_LOST: AttemptOutcome = "lease-lost";

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

/** What preparation hands the effect. */
interface Prepared {
  readonly actor: ActingUser;
  readonly delivery: Delivery;
  readonly effect: DeliveryEffect;
}

/**
 * Builds what an effect receives, inside a request transaction: the
 * subscription and its effect resolved from that transaction's snapshot
 * (`AttemptRefused` "configuration" when it no longer runs an effect of
 * the claimed kind), its current identity, and the payload from history.
 */
const prepare = Effect.fn("Outbox.prepareDelivery")(function* prepare(
  kind: DeliveryEffect["kind"],
  claimed: ClaimedDelivery
) {
  yield* (yield* WorkerProbes).preparing(claimed);
  const snapshot = yield* (yield* Catalog).current;
  const handlers = yield* DeliveryHandlers;
  const served = resolveServed(snapshot, handlers, claimed.subscriptionId);

  if (served === undefined || served.effect.kind !== kind) {
    return yield* new AttemptRefused({ reason: "configuration" });
  }

  const { subscription } = served;
  const actor = yield* identityOf(snapshot, subscription.identityId);
  const { timeZone } = yield* InstanceSettings;
  const now = yield* Clock.currentTimeMillis;
  const entries = yield* readEntries(claimed.recordId, claimed.recordVersion);
  const entry = entries.at(-1);

  if (entry?.changeId !== claimed.changeId) {
    return yield* new PayloadUnreadable({
      reason: `The change entry ${claimed.changeId} is not the record's entry at version ${claimed.recordVersion}.`,
    });
  }

  const origins = yield* readFieldOrigins(snapshot, entry.recordClassId);

  const payload = payloadOf(
    snapshot,
    actor,
    { entries, origins, recordId: claimed.recordId },
    { me: actor.userId, now, timeZone }
  );

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

  return { actor, delivery, effect: served.effect } satisfies Prepared;
});

const overdue = new AttemptRefused({ reason: "deadline" });

/**
 * Runs `effect` only before the deadline, and interrupts it there with
 * `AttemptRefused` "deadline": for everything before the handler.
 *
 * @param deadline - Epoch milliseconds.
 * @returns The bounded effect.
 */
const beforeDeadline =
  (deadline: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        now >= deadline
          ? Effect.fail(overdue)
          : effect.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(deadline - now),
                orElse: () => Effect.fail(overdue),
              })
            )
      )
    );

/**
 * The time left before the deadline, or `AttemptRefused` "deadline" when
 * none is: the last check before the handler is invoked.
 *
 * @param deadline - Epoch milliseconds.
 * @returns The time left.
 */
const timeLeft = (deadline: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      now >= deadline
        ? Effect.fail(overdue)
        : Effect.succeed(Duration.millis(deadline - now))
    )
  );

/**
 * One attempt: preparation, the handler and `done`, under the deadline.
 *
 * @param kind - The kind of effect the claim was made for.
 * @param claimed - The claimed row.
 * @param deadline - Epoch milliseconds.
 * @returns The attempt.
 */
const attemptOf = (
  kind: DeliveryEffect["kind"],
  claimed: ClaimedDelivery,
  deadline: number
) =>
  Effect.gen(function* attempt() {
    const { request } = yield* Transactions;

    if (kind === "record") {
      return yield* request(
        Effect.gen(function* recordDelivery() {
          const prepared = yield* prepare(kind, claimed).pipe(
            beforeDeadline(deadline)
          );

          if (prepared.effect.kind !== "record") {
            return yield* new AttemptRefused({ reason: "configuration" });
          }

          const left = yield* timeLeft(deadline);

          yield* prepared.effect
            .run(prepared.delivery)
            .pipe(
              Effect.timeout(left),
              Effect.provide(RuleWriteAccess),
              Effect.provideService(Actor, prepared.actor)
            );

          // The last statement: the effect's writes and `done` commit
          // together, or roll back together on a lost lease.
          return yield* markDone(claimed);
        })
      );
    }

    const prepared = yield* request(prepare(kind, claimed)).pipe(
      beforeDeadline(deadline)
    );

    if (prepared.effect.kind !== "external") {
      return yield* new AttemptRefused({ reason: "configuration" });
    }

    const left = yield* timeLeft(deadline);

    yield* prepared.effect.run(prepared.delivery).pipe(Effect.timeout(left));

    return yield* markDone(claimed);
  });

const TaggedSchema = Schema.Struct({ _tag: Schema.String });

const isTagged = Schema.is(TaggedSchema);

/**
 * The typed failure of an attempt, if it has one.
 *
 * @param cause - The attempt's failure.
 * @returns The error, or undefined for a defect or an untagged failure.
 */
const taggedFailure = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);

  return Option.isSome(error) && isTagged(error.value)
    ? error.value
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
  const failure = taggedFailure(cause);

  if (failure === undefined) {
    return Option.isNone(Cause.findErrorOption(cause))
      ? "Defect: the attempt died; see the worker log."
      : "Failure: the effect failed.";
  }

  if (
    failure instanceof DeliveryFailed ||
    failure instanceof PayloadUnreadable
  ) {
    return `${failure._tag}: ${failure.reason}`;
  }

  if (failure._tag === "TimeoutError") {
    return `TimeoutError: the effect did not finish within ${Duration.toMillis(timeout)} ms.`;
  }

  if (
    failure._tag === "DatabaseError" &&
    Predicate.hasProperty(failure, "sqlState")
  ) {
    return `DatabaseError: SQLSTATE ${String(failure.sqlState)}`;
  }

  return failure._tag;
};

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
 * What happens to a claim whose effect was not run: past the deadline it
 * is left to its lease; under a changed configuration it is released.
 *
 * @param refused - Why.
 * @param claimed - The claimed row.
 * @returns The outcome.
 */
const refusedOutcome = Effect.fnUntraced(function* refusedOutcome(
  refused: AttemptRefused,
  claimed: ClaimedDelivery
) {
  if (refused.reason === "deadline") {
    yield* Metric.update(deliveriesLeaseLost, 1);
    yield* Effect.logWarning(
      `Outbox delivery ${claimed.id}: its deadline passed before the effect started; left to its lease`
    );

    return "expired" satisfies AttemptOutcome;
  }

  return yield* releaseClaim(claimed).pipe(
    Effect.as<AttemptOutcome>("released"),
    Effect.catchTag("LeaseLost", () => Effect.succeed(LEASE_LOST)),
    Effect.catchTag("DatabaseError", () =>
      Effect.succeed<AttemptOutcome>("unrecorded")
    )
  );
});

/**
 * Runs one claimed delivery and records its outcome.
 *
 * @param served - The subscription, as the claim resolved it, and its effect.
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
    const probes = yield* WorkerProbes;

    yield* probes.beforeAttempt(claimed);

    const exit = yield* Effect.exit(
      attemptOf(served.effect.kind, claimed, deadline)
    );

    if (Exit.isSuccess(exit)) {
      yield* Metric.update(deliveriesDone, 1);

      return "done" satisfies AttemptOutcome;
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
      return "interrupted" satisfies AttemptOutcome;
    }

    const failure = taggedFailure(exit.cause);

    if (failure instanceof AttemptRefused) {
      return yield* refusedOutcome(failure, claimed);
    }

    if (failure?._tag === "LeaseLost") {
      yield* Metric.update(deliveriesLeaseLost, 1);
      yield* Effect.logWarning(
        `Outbox delivery ${claimed.id}: the lease was lost; the result is discarded`
      );

      return LEASE_LOST;
    }

    if (Option.isNone(Cause.findErrorOption(exit.cause))) {
      yield* Effect.logError(
        `Outbox delivery ${claimed.id} died`,
        Cause.pretty(exit.cause)
      );
    }

    const recorded = yield* markFailed(claimed, {
      error: describeFailure(exit.cause, settings.effectTimeout),
      maxAttempts: served.subscription.maxAttempts,
    }).pipe(
      Effect.map((outcome): AttemptOutcome => outcome),
      Effect.catchTag("LeaseLost", () => Effect.succeed(LEASE_LOST)),
      Effect.catchTag("DatabaseError", (databaseError) =>
        Effect.logWarning(
          `Outbox delivery ${claimed.id}: the failure was not recorded (SQLSTATE ${databaseError.sqlState})`
        ).pipe(Effect.as<AttemptOutcome>("unrecorded"))
      )
    );

    yield* Metric.update(counterOf(recorded), 1);

    if (recorded === "dead") {
      // Deaths are rare; the gauge shows them at once.
      yield* refreshDeadGauge().pipe(
        Effect.catchTag("DatabaseError", () => Effect.void)
      );
    }

    return recorded;
  }
);

/**
 * Claims one batch of a subscription's due deliveries and runs them. The
 * claim transaction resolves the subscription from its own snapshot and
 * claims nothing unless it is still active, enabled and served; the claim
 * uses its current dead-letter policy and `max_attempts`.
 *
 * @param subscriptionId - The subscription.
 * @returns How many rows were claimed.
 */
export const serveSubscription = Effect.fn("Outbox.serveSubscription")(
  function* serveSubscription(subscriptionId: DefinitionId) {
    const settings = yield* WorkerSettings;
    const handlers = yield* DeliveryHandlers;
    const { request } = yield* Transactions;
    const started = yield* Clock.currentTimeMillis;

    const claim = yield* request(
      Effect.gen(function* claimServed() {
        const snapshot = yield* (yield* Catalog).current;
        const served = resolveServed(snapshot, handlers, subscriptionId);

        if (served === undefined) {
          return null;
        }

        const rows = yield* claimInTransaction({
          deadLetter: served.subscription.deadLetter,
          lease: leaseOf(settings),
          limit: settings.batchSize,
          maxAttempts: served.subscription.maxAttempts,
          subscriptionId,
        });

        return { rows, served };
      })
    );

    if (claim === null) {
      return 0;
    }

    const deadline = started + Duration.toMillis(settings.effectTimeout);

    // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
    yield* Effect.forEach(
      claim.rows,
      (row) => runDelivery(claim.served, row, deadline),
      { concurrency: "unbounded", discard: true }
    );

    return claim.rows.length;
  }
);

/**
 * One pass over every subscription the latest configuration serves.
 * Database failures of a claim are logged; the next pass tries again.
 *
 * @returns How many rows the pass claimed.
 */
export const workerPass = Effect.fn("Outbox.workerPass")(
  function* workerPass() {
    const settings = yield* WorkerSettings;
    const handlers = yield* DeliveryHandlers;
    const snapshot = yield* (yield* Catalog).refresh;

    const candidates = snapshot
      .subscriptions()
      .filter(
        (subscription) =>
          resolveServed(snapshot, handlers, subscription.id) !== undefined
      );

    // oxlint-disable-next-line github/array-foreach -- Effect.forEach, not Array.prototype.forEach
    const counts = yield* Effect.forEach(
      candidates,
      (subscription) =>
        serveSubscription(subscription.id).pipe(
          Effect.catchTag("DatabaseError", (failure) =>
            Effect.logWarning(
              `Outbox claim for subscription ${subscription.id} failed (SQLSTATE ${failure.sqlState})`
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
  const probes = yield* WorkerProbes;
  const wake = yield* Queue.sliding<true>(1);
  const received = yield* Ref.make(0);

  yield* workerWakeups.pipe(
    Stream.runForEach((signal) =>
      Ref.update(received, (count) => count + 1).pipe(
        Effect.andThen(Queue.offer(wake, signal))
      )
    ),
    Effect.forkScoped
  );

  yield* housekeeping.pipe(
    Effect.andThen(Effect.sleep(settings.housekeepingInterval)),
    Effect.forever,
    Effect.forkScoped
  );

  const step = Effect.gen(function* workerStep() {
    const claimed = yield* workerPass();

    if (claimed > 0) {
      return;
    }

    yield* probes.idle({
      pendingWakeups: yield* Queue.size(wake),
      wakeSignals: yield* Ref.get(received),
    });

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
