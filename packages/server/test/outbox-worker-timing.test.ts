/**
 * The worker's deadline and its response to configuration changes
 * (Contracts 4.6; decision 0023; review round 1 findings 2 and 3).
 *
 * - One deadline covers acquiring the transaction, preparing the payload and
 *   the effect: when preparation is slow or the pool is saturated past it,
 *   neither kind of handler is invoked; the claim is left to its lease and
 *   the next claim runs it once.
 * - The claim transaction resolves the subscription from its own snapshot:
 *   a disable committed after a pass's refresh claims nothing.
 * - Preparation resolves it again: disabled after the claim, the claim is
 *   released without running or counting; an identity changed after the
 *   claim runs as the new identity.
 *
 * `WorkerProbes` holds the worker at fixed points; the lease is long, so
 * only the deadline, never the lease, decides.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { Deferred, Duration, Effect, Fiber, Ref } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import type { ClaimedDelivery } from "../src/outbox/delivery-claims.ts";
import type {
  Delivery,
  DeliveryEffect,
} from "../src/outbox/delivery-effects.ts";
import {
  serveSubscription,
  WorkerProbes,
  WorkerSettings,
  workerPass,
} from "../src/outbox/worker.ts";
import type { WorkerProbesApi } from "../src/outbox/worker.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { deliveriesWhere, subscribe } from "./outbox-support.ts";
import { ACME, change, values } from "./schema-support.ts";
import {
  createAsset,
  expireLease,
  serveOnly,
  workerTestLayer,
} from "./worker-support.ts";

/** The effect deadline of the overrun tests; the lease is minutes longer. */
const EFFECT_TIMEOUT = Duration.millis(200);

/** Longer than the deadline. */
const STALL = Duration.millis(600);

const POOL_SIZE = 4;

// The default effect timeout for the configuration-change tests, which
// commit a schema change set while the claim is held in `beforeAttempt`.
const withDefaultEffectTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    WorkerSettings.layerOf({ leaseMargin: Duration.minutes(5) })
  );

const NO_PROBES: WorkerProbesApi = {
  beforeAttempt: () => Effect.void,
  idle: () => Effect.void,
  preparing: () => Effect.void,
};

const withProbes =
  (probes: Partial<WorkerProbesApi>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, WorkerProbes, { ...NO_PROBES, ...probes });

const firstAttemptOnly =
  (stall: Effect.Effect<void>) => (claimed: ClaimedDelivery) =>
    claimed.attempts === 1 ? stall : Effect.void;

// The one row of a subscription for a record.
const rowOf = (subscriptionId: string, recordId: string) =>
  deliveriesWhere("subscription_id = $1::uuid AND record_id = $2::uuid", [
    subscriptionId,
    recordId,
  ]).pipe(Effect.map(([row]) => row));

// Assets a record effect created for a change.
const effectWrites = (changeId: string) =>
  values(`SELECT id::text AS value FROM "acme"."asset" WHERE name = $1`, [
    `effect ${changeId}`,
  ]);

// A counting effect of either kind; the record kind also writes.
const countingEffect = (
  kind: DeliveryEffect["kind"],
  calls: Ref.Ref<readonly Delivery[]>
): DeliveryEffect => {
  const count = (delivery: Delivery) =>
    Ref.update(calls, (all) => [...all, delivery]);

  return kind === "external"
    ? { kind, run: count }
    : {
        kind,
        run: (delivery: Delivery) =>
          createRecord({
            body: { name: `effect ${delivery.changeId}`, status: "new" },
            cause: delivery.cause,
            endpointClassId: ACME.asset,
          }).pipe(Effect.andThen(count(delivery))),
      };
};

/** A watched new asset and a counting effect for its subscription. */
const watchedAsset = Effect.fn("TimingTest.watchedAsset")(function* watched(
  kind: DeliveryEffect["kind"],
  name: string
) {
  const fixture = yield* AcmeFixture;
  const calls = yield* Ref.make<readonly Delivery[]>([]);

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.admin.id,
    operations: ["create"],
  });

  yield* serveOnly(subscription, countingEffect(kind, calls));

  const id = yield* createAsset(fixture.admin.id, { name, status: "in_use" });

  return { calls, id, subscription };
});

/**
 * The first attempt overruns the deadline in `stall`: no handler runs, the
 * row keeps its claim; after the lease, the handler runs exactly once.
 */
const overrun = Effect.fn("TimingTest.overrun")(function* overrun(
  kind: DeliveryEffect["kind"],
  probes: Partial<WorkerProbesApi>
) {
  const { calls, id, subscription } = yield* watchedAsset(
    kind,
    `overrun-${kind}`
  );

  assert.strictEqual(yield* workerPass().pipe(withProbes(probes)), 1);
  assert.deepStrictEqual(
    yield* Ref.get(calls),
    [],
    "no handler past the deadline"
  );

  const held = yield* rowOf(subscription, id);

  assert.strictEqual(held?.status, "in_flight", "left to its lease");
  assert.strictEqual(held?.attempts, 1);
  assert.isNull(held?.last_error, "nothing recorded");

  yield* expireLease(subscription, id, 1);
  assert.strictEqual(yield* workerPass(), 1);

  const calledWith = yield* Ref.get(calls);

  assert.lengthOf(calledWith, 1, "the next claim runs it once");

  const done = yield* rowOf(subscription, id);

  assert.strictEqual(done?.status, "done");
  assert.strictEqual(done?.attempts, 2);

  if (kind === "record") {
    assert.lengthOf(
      yield* effectWrites(calledWith[0]?.changeId ?? ""),
      1,
      "one write"
    );
  }
});

const slowPreparation = (kind: DeliveryEffect["kind"]) =>
  overrun(kind, { preparing: firstAttemptOnly(Effect.sleep(STALL)) });

// Holds every pooled connection in a transaction for `STALL`, from the
// moment the claimed delivery wants one.
const saturatePool = Effect.gen(function* saturatePoolProbe() {
  const { request } = yield* Transactions;

  return firstAttemptOnly(
    Effect.gen(function* occupyEveryConnection() {
      const holding = yield* Ref.make(0);
      const allHeld = yield* Deferred.make<boolean>();

      for (let index = 0; index < POOL_SIZE; index += 1) {
        yield* request(
          Effect.gen(function* holdConnection() {
            const held = yield* Ref.updateAndGet(holding, (n) => n + 1);

            if (held === POOL_SIZE) {
              yield* Deferred.succeed(allHeld, true);
            }

            yield* Effect.sleep(STALL);
          })
        ).pipe(Effect.ignore, Effect.forkDetach);
      }

      yield* Deferred.await(allHeld);
    })
  );
});

const poolContention = (kind: DeliveryEffect["kind"]) =>
  Effect.gen(function* poolContentionTest() {
    const beforeAttempt = yield* saturatePool;

    yield* overrun(kind, { beforeAttempt });
  });

/** Changes properties of a subscription through a change set. */
const updateSubscription = Effect.fn("TimingTest.updateSubscription")(
  function* updateSubscription(
    subscriptionId: string,
    changes: Readonly<Record<string, string | boolean>>
  ) {
    const snapshot = yield* (yield* Catalog).refresh;
    const version = snapshot.get(subscriptionId)?.version ?? 0;

    const update: Operation = {
      changes,
      id: subscriptionId,
      op: "update",
      version,
    };

    yield* change([update]);
  }
);

const disabledBeforeClaim = Effect.gen(function* disabledBeforeClaimTest() {
  const { calls, id, subscription } = yield* watchedAsset("external", "before");

  // A pass refreshed and found the subscription served; then the disable
  // commits; then the pass claims for it.
  yield* updateSubscription(subscription, { enabled: false });

  assert.strictEqual(yield* serveSubscription(subscription), 0);
  assert.deepStrictEqual(yield* Ref.get(calls), []);

  const row = yield* rowOf(subscription, id);

  assert.strictEqual(row?.status, "pending");
  assert.strictEqual(row?.attempts, 0);
});

// Runs a pass that stops after its claim until `whileHeld` has run.
const heldPass = <E, R>(whileHeld: Effect.Effect<void, E, R>) =>
  Effect.gen(function* heldPassRun() {
    const claimed = yield* Deferred.make<boolean>();
    const go = yield* Deferred.make<boolean>();

    const pass = yield* workerPass().pipe(
      withProbes({
        beforeAttempt: firstAttemptOnly(
          Deferred.succeed(claimed, true).pipe(
            Effect.andThen(Deferred.await(go)),
            Effect.asVoid
          )
        ),
      }),
      Effect.forkChild
    );

    yield* Deferred.await(claimed);
    yield* whileHeld;
    yield* Deferred.succeed(go, true);

    return yield* Fiber.join(pass);
  });

const disabledAfterClaim = Effect.gen(function* disabledAfterClaimTest() {
  const { calls, id, subscription } = yield* watchedAsset("record", "after");

  const claimed = yield* heldPass(
    updateSubscription(subscription, { enabled: false })
  );

  assert.strictEqual(claimed, 1);
  assert.deepStrictEqual(yield* Ref.get(calls), [], "not run");

  const released = yield* rowOf(subscription, id);

  assert.strictEqual(released?.status, "pending", "released");
  assert.strictEqual(released?.attempts, 0, "not counted as an attempt");
  assert.isNull(released?.lease_token);
  assert.strictEqual(yield* workerPass(), 0, "paused while disabled");

  yield* updateSubscription(subscription, { enabled: true });
  assert.strictEqual(yield* workerPass(), 1);
  assert.lengthOf(yield* Ref.get(calls), 1);
  assert.strictEqual((yield* rowOf(subscription, id))?.attempts, 1);
}).pipe(withDefaultEffectTimeout);

const identityAfterClaim = Effect.gen(function* identityAfterClaimTest() {
  const fixture = yield* AcmeFixture;
  const { calls, subscription } = yield* watchedAsset("external", "identity");

  yield* heldPass(
    updateSubscription(subscription, { identityId: fixture.bob.id })
  );

  const [delivery] = yield* Ref.get(calls);

  assert.strictEqual(delivery?.subscription.identityId, fixture.bob.id);
  assert.isFalse(
    delivery?.payload.visible,
    "filtered for Bob: the asset is not his"
  );
}).pipe(withDefaultEffectTimeout);

describe("outbox-worker-timing", () => {
  it("stalls longer than the deadline", () => {
    assert.isAbove(Duration.toMillis(STALL), Duration.toMillis(EFFECT_TIMEOUT));
  });

  layer(
    workerTestLayer(
      { effectTimeout: EFFECT_TIMEOUT, leaseMargin: Duration.minutes(5) },
      { maxConnections: POOL_SIZE }
    ),
    { excludeTestServices: true }
  )((dbTest) => {
    dbTest.effect(
      "delayed preparation: past the deadline an external handler is not invoked; the next claim runs it once",
      () => slowPreparation("external")
    );

    dbTest.effect(
      "delayed preparation: past the deadline a record handler is not invoked; the next claim writes once",
      () => slowPreparation("record")
    );

    dbTest.effect(
      "pool contention: a delivery that gets its connection after the deadline does not invoke an external handler",
      () => poolContention("external")
    );

    dbTest.effect(
      "pool contention: a delivery that gets its connection after the deadline does not invoke a record handler",
      () => poolContention("record")
    );

    dbTest.effect(
      "a subscription disabled after a pass's refresh is not claimed for",
      () => disabledBeforeClaim
    );

    dbTest.effect(
      "a subscription disabled after the claim is not run: the claim is released, uncounted, and runs once re-enabled",
      () => disabledAfterClaim
    );

    dbTest.effect(
      "an identity changed after the claim: the effect runs as the new identity, its payload filtered for it",
      () => identityAfterClaim
    );
  });
});
