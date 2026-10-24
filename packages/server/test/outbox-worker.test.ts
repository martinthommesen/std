/**
 * The outbox worker (Contracts 4.6, 4.7 and their Step 3 acceptance tests;
 * plan gate 3B): lease fencing, failures and backoff in per-record order,
 * dead letters under `block` and `skip` with the operator's retry and
 * discard, payloads filtered for the subscription's identity (4.5),
 * secrets, identities, the effect timeout, retention and wake-ups.
 *
 * The tests drive worker passes directly, so every step is deterministic;
 * table-owner edits of `lease_until` and `next_attempt_at` stand in for
 * the passage of time. Only the wake-up test runs the worker loop.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  USER_CLASS_ID,
  SYSTEM_USER_ID,
  HELPDESK_CASCADE_USER_ID,
} from "@std/definitions/well-known";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Metric,
  Queue,
  Ref,
  Stream,
} from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  discardDeadDelivery,
  listDeadDeliveries,
  retryDeadDelivery,
} from "../src/outbox/dead-letters.ts";
import { claimDeliveries } from "../src/outbox/delivery-claims.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { DeliveryFailed } from "../src/outbox/delivery-failed.ts";
import { deadDeliveries } from "../src/outbox/metrics.ts";
import type { IdleState } from "../src/outbox/worker.ts";
import {
  DEFAULT_WORKER_SETTINGS,
  deleteOldDeliveries,
  leaseOf,
  runWorker,
  WorkerProbes,
  WorkerSettings,
  workerPass,
  workerWakeups,
} from "../src/outbox/worker.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { deliveriesWhere, subscribe } from "./outbox-support.ts";
import { asUser } from "./records-support.ts";
import { values } from "./schema-support.ts";
import {
  asLoadedUser,
  createAsset,
  deleteAsset,
  dueNow,
  expireLease,
  keyOf,
  serveOnly,
  setDeliveryOf,
  updateAsset,
  workerTestLayer,
  effectWrites,
  writeEffectAsset,
} from "./worker-support.ts";

// One subscription's rows of a record, as `version:status:attempts`.
const statesOf = (recordId: string, subscriptionId: string) =>
  deliveriesWhere("record_id = $1::uuid AND subscription_id = $2::uuid", [
    recordId,
    subscriptionId,
  ]).pipe(
    Effect.map((rows) =>
      rows.map((row) => `${row.record_version}:${row.status}:${row.attempts}`)
    )
  );

// One subscription's row of a record version.
const rowAt = (subscriptionId: string, recordId: string, version: number) =>
  deliveriesWhere(
    "subscription_id = $1::uuid AND record_id = $2::uuid AND record_version = $3::int8",
    [subscriptionId, recordId, String(version)]
  ).pipe(Effect.map(([row]) => row));

// A claim that only looks: whatever it returns is a test failure.
const claimNow = (subscriptionId: string) =>
  claimDeliveries({
    deadLetter: "block",
    lease: Duration.minutes(5),
    limit: 10,
    maxAttempts: 10,
    subscriptionId,
  });

const appendTo = (log: Ref.Ref<readonly string[]>, entry: string) =>
  Ref.update(log, (entries) => [...entries, entry]);

const collect = (log: Ref.Ref<readonly Delivery[]>) => (delivery: Delivery) =>
  Ref.update(log, (all) => [...all, delivery]);

const refuse = (reason: string) => Effect.fail(new DeliveryFailed({ reason }));

// An asset R updated twice (versions 2 and 3), watched for updates.
const twoUpdates = Effect.fn("WorkerTest.twoUpdates")(function* twoUpdates(
  name: string,
  spec: {
    readonly deadLetter?: "block" | "skip";
    readonly maxAttempts?: number;
  }
) {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: admin,
    operations: ["update"],
    ...spec,
  });

  const r = yield* createAsset(admin, { name, status: "in_use" });

  yield* updateAsset(admin, r, 1, { name: `${name}2` });
  yield* updateAsset(admin, r, 2, { name: `${name}3` });

  return { admin, r, subscription };
});

/** The gates of the lease-fencing tests. */
interface Gates {
  readonly w1Claimed: Deferred.Deferred<boolean>;
  readonly w1Release: Deferred.Deferred<boolean>;
  readonly w2Claimed: Deferred.Deferred<boolean>;
  readonly w2Release: Deferred.Deferred<boolean>;
}

// W1 (attempt 1 of version 2) stalls until released, then succeeds or
// fails; W2 (attempt 2) waits so the test can look before it is done.
const fencedEffect = (
  gates: Gates,
  arrivals: Ref.Ref<readonly string[]>,
  outcome: "succeeds" | "fails"
) =>
  Effect.fnUntraced(function* fenced(delivery: Delivery) {
    const late = delivery.recordVersion === 2 && delivery.attempts === 1;

    if (late) {
      yield* Deferred.succeed(gates.w1Claimed, true);
      yield* Deferred.await(gates.w1Release);
    }

    if (late && outcome === "fails") {
      return yield* new DeliveryFailed({ reason: "late failure" });
    }

    if (delivery.recordVersion === 2 && delivery.attempts === 2) {
      yield* Deferred.succeed(gates.w2Claimed, true);
      yield* Deferred.await(gates.w2Release);
    }

    return yield* appendTo(
      arrivals,
      `${delivery.recordVersion}:${delivery.attempts}`
    );
  });

const leaseFencing = Effect.fn("WorkerTest.leaseFencing")(function* fencing(
  outcome: "succeeds" | "fails"
) {
  const { r, subscription } = yield* twoUpdates(`fence-${outcome}`, {});
  const arrivals = yield* Ref.make<readonly string[]>([]);

  const gates: Gates = {
    w1Claimed: yield* Deferred.make<boolean>(),
    w1Release: yield* Deferred.make<boolean>(),
    w2Claimed: yield* Deferred.make<boolean>(),
    w2Release: yield* Deferred.make<boolean>(),
  };

  yield* serveOnly(subscription, {
    kind: "external",
    run: fencedEffect(gates, arrivals, outcome),
  });

  // W1 claims version 2 and stalls.
  const w1 = yield* workerPass().pipe(Effect.forkChild);
  yield* Deferred.await(gates.w1Claimed);
  assert.deepStrictEqual(yield* claimNow(subscription), [], "3 waits for 2");

  // W1's lease runs out; W2 claims version 2 under a new token.
  yield* expireLease(subscription, r, 2);
  const w2 = yield* workerPass().pipe(Effect.forkChild);
  yield* Deferred.await(gates.w2Claimed);
  assert.deepStrictEqual(
    yield* claimNow(subscription),
    [],
    "n+1 is not claimable before W2 marks n done"
  );

  yield* Deferred.succeed(gates.w2Release, true);
  assert.strictEqual(yield* Fiber.join(w2), 1);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:2",
    "3:pending:0",
  ]);

  // W1 comes back: its done or failure update finds no lease.
  yield* Deferred.succeed(gates.w1Release, true);
  assert.strictEqual(yield* Fiber.join(w1), 1);

  const late = yield* rowAt(subscription, r, 2);

  assert.strictEqual(late?.status, "done");
  assert.strictEqual(late?.attempts, 2);
  assert.isNull(late?.last_error, "W1's failure changed nothing");
  assert.isNull(late?.lease_token);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:2",
    "3:pending:0",
  ]);

  // Only now is version 3 claimed.
  assert.strictEqual(yield* workerPass(), 1);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:2",
    "3:done:1",
  ]);

  assert.deepStrictEqual(
    yield* Ref.get(arrivals),
    outcome === "succeeds" ? ["2:2", "2:1", "3:1"] : ["2:2", "3:1"],
    "an external effect is at least once: W1's late call still happened"
  );
});

// Creates an asset named after the change; attempt 1 of version 2 then
// stalls inside its delivery transaction until released.
const writingEffect = (
  wrote: Deferred.Deferred<boolean>,
  release: Deferred.Deferred<boolean>
) =>
  Effect.fnUntraced(function* writeOnce(delivery: Delivery) {
    yield* writeEffectAsset(delivery);

    if (delivery.attempts === 1 && delivery.recordVersion === 2) {
      yield* Deferred.succeed(wrote, true);
      yield* Deferred.await(release);
    }
  });

const recordFencing = Effect.gen(function* recordFencingTest() {
  const { r, subscription } = yield* twoUpdates("fence-record", {});
  const w1Wrote = yield* Deferred.make<boolean>();
  const w1Release = yield* Deferred.make<boolean>();

  yield* serveOnly(subscription, {
    kind: "record",
    run: writingEffect(w1Wrote, w1Release),
  });

  const w1 = yield* workerPass().pipe(Effect.forkChild);
  yield* Deferred.await(w1Wrote);
  yield* expireLease(subscription, r, 2);

  assert.strictEqual(yield* workerPass(), 1, "W2 writes and is done");
  yield* Deferred.succeed(w1Release, true);
  yield* Fiber.join(w1);

  const changeId = (yield* rowAt(subscription, r, 2))?.change_id ?? "";
  const written = yield* effectWrites(changeId);

  assert.lengthOf(written, 1, "W1's write rolled back with its done");
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:2",
    "3:pending:0",
  ]);

  const [cause] = yield* values(
    `SELECT cause::text AS value FROM core."change" WHERE record_id = $1::uuid`,
    [written[0] ?? ""]
  );

  assert.deepStrictEqual(JSON.parse(cause ?? "null"), {
    kind: "after_commit",
    parentChangeId: changeId,
    subscriptionId: subscription,
  });
});

// Fails R@2 the first two times it runs; logs every arrival.
const flakyEffect = (
  r: string,
  failures: Ref.Ref<number>,
  arrivals: Ref.Ref<readonly string[]>
) =>
  Effect.fnUntraced(function* flaky(delivery: Delivery) {
    const isR2 = delivery.recordId === r && delivery.recordVersion === 2;
    const failed = isR2 ? yield* Ref.getAndUpdate(failures, (n) => n + 1) : 2;

    return failed < 2
      ? yield* refuse(`listener refused (${failed + 1})`)
      : yield* appendTo(arrivals, keyOf(delivery));
  });

const failingTwice = Effect.gen(function* failingTwiceTest() {
  const { admin, r, subscription } = yield* twoUpdates("twice", {});
  const q = yield* createAsset(admin, { name: "Q", status: "in_use" });
  const arrivals = yield* Ref.make<readonly string[]>([]);
  const failures = yield* Ref.make(0);

  yield* updateAsset(admin, q, 1, { name: "Q2" });

  yield* serveOnly(subscription, {
    kind: "external",
    run: flakyEffect(r, failures, arrivals),
  });

  assert.strictEqual(yield* workerPass(), 2, "R@2 fails, Q@2 done");
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:pending:1",
    "3:pending:0",
  ]);

  const [backoff] = yield* values(
    `SELECT (extract(epoch FROM next_attempt_at - now()))::text AS value
     FROM core.delivery
     WHERE record_id = $1::uuid AND record_version = 2
       AND subscription_id = $2::uuid`,
    [r, subscription]
  );

  assert.isAbove(Number(backoff), 7, "backs off about 10 s");
  assert.strictEqual(yield* workerPass(), 0, "nothing due");

  yield* updateAsset(admin, q, 2, { name: "Q3" });
  yield* dueNow(subscription, r, 2);
  assert.strictEqual(yield* workerPass(), 2, "R@2 fails, Q@3 done");
  assert.strictEqual(
    (yield* rowAt(subscription, r, 2))?.last_error,
    "DeliveryFailed: listener refused (2)"
  );

  yield* dueNow(subscription, r, 2);
  assert.strictEqual(yield* workerPass(), 1, "R@2 arrives");
  assert.strictEqual(yield* workerPass(), 1, "then R@3");

  assert.deepStrictEqual(yield* Ref.get(arrivals), [
    `${q}@2`,
    `${q}@3`,
    `${r}@2`,
    `${r}@3`,
  ]);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:3",
    "3:done:1",
  ]);
});

// Refuses R@2's first delivery for good (with `max_attempts` 1).
const refuseFirstOf = (
  r: string,
  refused: Ref.Ref<boolean>,
  arrivals: Ref.Ref<readonly string[]>
) =>
  Effect.fnUntraced(function* refuseFirst(delivery: Delivery) {
    const isR2 = delivery.recordId === r && delivery.recordVersion === 2;
    const refuseNow = isR2 && !(yield* Ref.getAndSet(refused, true));

    return refuseNow
      ? yield* refuse("always refused")
      : yield* appendTo(arrivals, keyOf(delivery));
  });

const blockPolicy = Effect.gen(function* blockPolicyTest() {
  const fixture = yield* AcmeFixture;

  const { admin, r, subscription } = yield* twoUpdates("block", {
    deadLetter: "block",
    maxAttempts: 1,
  });

  const q = yield* createAsset(admin, { name: "Qb", status: "in_use" });
  const arrivals = yield* Ref.make<readonly string[]>([]);
  const refused = yield* Ref.make(false);

  yield* updateAsset(admin, q, 1, { name: "Qb2" });

  yield* serveOnly(subscription, {
    kind: "external",
    run: refuseFirstOf(r, refused, arrivals),
  });

  assert.strictEqual(yield* workerPass(), 2);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:dead:1",
    "3:pending:0",
  ]);
  assert.strictEqual(yield* workerPass(), 0, "R@3 is held back");
  assert.deepStrictEqual(yield* Ref.get(arrivals), [`${q}@2`]);

  const dead = yield* listDeadDeliveries({
    limit: 100,
    subscriptionId: subscription,
  }).pipe(asLoadedUser(admin));

  assert.lengthOf(dead, 1);
  assert.strictEqual(dead[0]?.recordId, r);
  assert.strictEqual(dead[0]?.lastError, "DeliveryFailed: always refused");
  assert.isAtLeast(
    (yield* Metric.value(deadDeliveries)).value,
    1,
    "the gauge counts it"
  );

  const deadId = dead[0]?.id ?? "";

  for (const user of [fixture.alice.id, fixture.bob.id]) {
    const listed = yield* Effect.flip(
      listDeadDeliveries({ limit: 10 }).pipe(asLoadedUser(user))
    );

    const discarded = yield* Effect.flip(
      discardDeadDelivery(deadId).pipe(asLoadedUser(user))
    );

    assert.strictEqual(listed._tag, "NotAllowed");
    assert.strictEqual(discarded._tag, "NotAllowed");
  }

  yield* discardDeadDelivery(deadId).pipe(asLoadedUser(admin));

  const again = yield* Effect.flip(
    discardDeadDelivery(deadId).pipe(asLoadedUser(admin))
  );

  assert.strictEqual(again._tag, "NotFound", "only dead rows");
  assert.strictEqual(yield* workerPass(), 1, "R@3 is released");
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:1",
    "3:done:1",
  ]);
  assert.deepStrictEqual(yield* Ref.get(arrivals), [`${q}@2`, `${r}@3`]);
});

const skipPolicy = Effect.gen(function* skipPolicyTest() {
  const { admin, r, subscription } = yield* twoUpdates("skip", {
    deadLetter: "skip",
    maxAttempts: 1,
  });

  const arrivals = yield* Ref.make<readonly string[]>([]);
  const refused = yield* Ref.make(false);

  yield* serveOnly(subscription, {
    kind: "external",
    run: refuseFirstOf(r, refused, arrivals),
  });

  assert.strictEqual(yield* workerPass(), 1, "R@2 dies");
  assert.strictEqual(yield* workerPass(), 1, "R@3 proceeds");
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:dead:1",
    "3:done:1",
  ]);

  const [dead] = yield* listDeadDeliveries({
    limit: 10,
    subscriptionId: subscription,
  }).pipe(asLoadedUser(admin));

  yield* retryDeadDelivery(dead?.id ?? "").pipe(asLoadedUser(admin));
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:pending:0",
    "3:done:1",
  ]);

  assert.strictEqual(yield* workerPass(), 1);
  assert.deepStrictEqual(yield* Ref.get(arrivals), [`${r}@3`, `${r}@2`]);
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:done:1",
    "3:done:1",
  ]);
});

const deletePayload = Effect.gen(function* deletePayloadTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const { L, AM } = fixture.records;
  const payloads = yield* Ref.make<readonly Delivery[]>([]);

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.bob.id,
    operations: ["delete"],
  });

  yield* serveOnly(subscription, { kind: "external", run: collect(payloads) });

  // Bob's laptop L, and Alice's monitor AM (L's dock, so L first).
  yield* deleteAsset(admin, L, 1);
  yield* deleteAsset(admin, AM, 1);
  assert.strictEqual(yield* workerPass(), 2);

  // Both run in one pass, concurrently: find each by its record.
  const delivered = yield* Ref.get(payloads);
  const ofL = delivered.find((delivery) => delivery.recordId === L);
  const ofAM = delivered.find((delivery) => delivery.recordId === AM);

  assert.strictEqual(ofL?.payload.kind, "delete");
  assert.strictEqual(ofL?.payload.recordVersion, 2);
  assert.isTrue(ofL?.payload.visible);
  assert.strictEqual(ofL?.payload.actorId, admin);

  // Bob reads his own assets' fields except cost (rule 5); the laptop's
  // serial (rule 8) but not its disk key; purchased_on and docked_to
  // because L is in use and cheap (rules 6 and 10).
  assert.deepStrictEqual(ofL?.payload.image, {
    [ACME.name]: "L",
    [ACME.owner]: fixture.bob.id,
    [ACME.status]: "in_use",
    [ACME.purchasedOn]: "2025-01-15",
    [ACME.dockedTo]: AM,
    [ACME.serial]: "SN-L",
  });
  assert.deepStrictEqual(
    Object.keys(ofL?.payload.changes ?? {}).toSorted(),
    Object.keys(ofL?.payload.image ?? {}).toSorted()
  );
  assert.notInclude(JSON.stringify(ofL?.payload), "1200");
  assert.notInclude(JSON.stringify(ofL?.payload), "L-DISK-KEY");

  // Alice's monitor is not Bob's: nothing but the fact of a delivery.
  assert.isFalse(ofAM?.payload.visible);
  assert.isNull(ofAM?.payload.actorId);
  assert.deepStrictEqual(ofAM?.payload.image, {});
  assert.deepStrictEqual(ofAM?.payload.changes, {});
});

const ownImage = Effect.gen(function* ownImageTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const { S } = fixture.records;
  const payloads = yield* Ref.make<readonly Delivery[]>([]);

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.bob.id,
    operations: ["update"],
  });

  yield* serveOnly(subscription, { kind: "external", run: collect(payloads) });

  // S is lost and costs 2500: Bob cannot read purchased_on or docked_to on
  // it. Found, then cheap, then lost again; delivered only afterwards.
  yield* updateAsset(admin, S, 1, { status: "in_use" });
  yield* updateAsset(admin, S, 2, { cost: "100" });
  yield* updateAsset(admin, S, 3, { status: "lost" });

  assert.strictEqual(yield* workerPass(), 1);
  assert.strictEqual(yield* workerPass(), 1);
  assert.strictEqual(yield* workerPass(), 1);

  const delivered = yield* Ref.get(payloads);
  const base = [ACME.name, ACME.owner, ACME.status];

  assert.deepStrictEqual(
    delivered.map((delivery) => Object.keys(delivery.payload.image).toSorted()),
    [
      [...base, ACME.purchasedOn].toSorted(),
      [...base, ACME.purchasedOn, ACME.dockedTo].toSorted(),
      [...base, ACME.dockedTo].toSorted(),
    ]
  );
  assert.deepStrictEqual(
    delivered.map((delivery) => delivery.payload.image[ACME.status]),
    ["in_use", "in_use", "lost"]
  );
  assert.deepStrictEqual(
    delivered[1]?.payload.changes,
    {},
    "cost changed, which Bob cannot read"
  );
});

const secretCanary = Effect.gen(function* secretCanaryTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const payloads = yield* Ref.make<readonly Delivery[]>([]);
  const canary = "canary-secret-7f3a9";

  const subscription = yield* subscribe({
    classId: USER_CLASS_ID,
    identityId: admin,
    operations: ["create"],
  });

  yield* serveOnly(subscription, { kind: "external", run: collect(payloads) });

  yield* createRecord({
    body: { active: true, login: "dora", name: "Dora", password: canary },
    endpointClassId: USER_CLASS_ID,
  }).pipe(asUser(admin));

  assert.strictEqual(yield* workerPass(), 1);

  const [delivery] = yield* Ref.get(payloads);
  const text = JSON.stringify(delivery?.payload);

  assert.isTrue(delivery?.payload.visible);
  assert.include(text, "dora");
  assert.notInclude(text, canary);
  assert.notInclude(text, "scrypt");
  assert.notInclude(text, "changed");
});

const inactiveIdentity = Effect.gen(function* inactiveIdentityTest() {
  const fixture = yield* AcmeFixture;
  const ran = yield* Ref.make(0);

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.carol.id,
    operations: ["create"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: () => Ref.update(ran, (n) => n + 1),
  });

  const id = yield* createAsset(fixture.admin.id, {
    name: "for Carol",
    status: "in_use",
  });

  assert.strictEqual(yield* workerPass(), 1);

  const row = yield* rowAt(subscription, id, 1);

  assert.strictEqual(row?.status, "pending");
  assert.strictEqual(
    row?.last_error,
    "DeliveryFailed: The subscription's identity is missing or inactive."
  );
  assert.strictEqual(yield* Ref.get(ran), 0);
});

const reservedIdentity = Effect.gen(function* reservedIdentity() {
  const fixture = yield* AcmeFixture;

  for (const identityId of [SYSTEM_USER_ID, HELPDESK_CASCADE_USER_ID]) {
    const ran = yield* Ref.make(0);

    const subscription = yield* subscribe({
      classId: ACME.asset,
      identityId: fixture.admin.id,
      maxAttempts: 1,
      operations: ["create"],
    });

    yield* values(
      "UPDATE core.subscription SET identity_id = $2::uuid WHERE id = $1::uuid RETURNING id::text AS value",
      [subscription, identityId]
    );
    yield* (yield* Catalog).refresh;
    yield* serveOnly(subscription, {
      kind: "external",
      run: () => Ref.update(ran, (n) => n + 1),
    });

    const id = yield* createAsset(fixture.admin.id, {
      name: "Reserved identity",
      status: "in_use",
    });

    assert.strictEqual(yield* workerPass(), 1);
    const row = yield* rowAt(subscription, id, 1);
    assert.strictEqual(row?.status, "dead");
    assert.include(row?.last_error ?? "", "reserved service identity");
    assert.strictEqual(yield* Ref.get(ran), 0);
  }
});

const retention = Effect.gen(function* retentionTest() {
  const { r, subscription } = yield* twoUpdates("retention", {
    deadLetter: "skip",
    maxAttempts: 1,
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: (delivery: Delivery) =>
      delivery.recordVersion === 2 ? refuse("dies") : Effect.void,
  });

  yield* workerPass();
  yield* workerPass();
  assert.deepStrictEqual(yield* statesOf(r, subscription), [
    "2:dead:1",
    "3:done:1",
  ]);

  yield* deleteOldDeliveries();
  assert.lengthOf(yield* statesOf(r, subscription), 2, "fresh rows stay");

  const eightDaysAgo = "finished_at = now() - interval '8 days'";

  yield* setDeliveryOf(eightDaysAgo, subscription, r, 2);
  yield* setDeliveryOf(eightDaysAgo, subscription, r, 3);
  yield* deleteOldDeliveries();
  assert.deepStrictEqual(yield* statesOf(r, subscription), ["2:dead:1"]);
});

const effectTimeout = Effect.gen(function* effectTimeoutTest() {
  const fixture = yield* AcmeFixture;
  const interrupted = yield* Deferred.make<boolean>();

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.admin.id,
    operations: ["create"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: () =>
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(interrupted, true))
      ),
  });

  const id = yield* createAsset(fixture.admin.id, {
    name: "slow",
    status: "in_use",
  });

  assert.strictEqual(yield* workerPass(), 1);
  assert.isTrue(yield* Deferred.isDone(interrupted));

  const row = yield* rowAt(subscription, id, 1);

  assert.strictEqual(row?.status, "pending");
  assert.strictEqual(
    row?.last_error,
    "TimeoutError: the effect did not finish within 300 ms."
  );
});

const wakeUp = Effect.gen(function* wakeUpTest() {
  const fixture = yield* AcmeFixture;
  const arrived = yield* Deferred.make<string>();
  const signals = yield* Queue.unbounded<true>();

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.admin.id,
    operations: ["create"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: (delivery: Delivery) =>
      Deferred.succeed(arrived, delivery.recordId).pipe(Effect.asVoid),
  });

  const idle = yield* Queue.unbounded<IdleState>();

  // The worker loop, polling once an hour, reports each time it waits.
  yield* runWorker.pipe(
    Effect.provideService(WorkerProbes, {
      beforeAttempt: () => Effect.void,
      idle: (state) => Queue.offer(idle, state).pipe(Effect.asVoid),
      preparing: () => Effect.void,
    }),
    Effect.forkScoped
  );

  // Wait until it is idle with LISTEN established (its first wake-up
  // received) and no wake-up pending: its empty passes are over, and only
  // a notification or the hour can start the next.
  let state = yield* Queue.take(idle);

  while (state.wakeSignals === 0 || state.pendingWakeups > 0) {
    state = yield* Queue.take(idle);
  }

  const id = yield* createAsset(fixture.admin.id, {
    name: "wake",
    status: "in_use",
  });

  assert.strictEqual(
    yield* Deferred.await(arrived).pipe(Effect.timeout("10 seconds")),
    id,
    "the save's NOTIFY woke the idle worker"
  );

  // The same notifications reach any listener.
  yield* workerWakeups.pipe(
    Stream.runForEach((signal) => Queue.offer(signals, signal)),
    Effect.forkScoped
  );
  yield* Queue.take(signals);
  yield* createAsset(fixture.admin.id, { name: "wake 2", status: "in_use" });

  assert.isTrue(
    yield* Queue.take(signals).pipe(Effect.timeout("10 seconds")),
    "a save's NOTIFY arrives"
  );
}).pipe(Effect.scoped);

describe("outbox-worker", () => {
  it("a lease outlasts the effect timeout by the margin", () => {
    assert.strictEqual(
      Duration.toMillis(leaseOf(DEFAULT_WORKER_SETTINGS)),
      Duration.toMillis(DEFAULT_WORKER_SETTINGS.effectTimeout) +
        Duration.toMillis(DEFAULT_WORKER_SETTINGS.leaseMargin)
    );
    assert.isAbove(Duration.toMillis(DEFAULT_WORKER_SETTINGS.leaseMargin), 0);
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "lease fencing: W1 paused past its lease cannot mark the delivery done; n+1 is claimed only after W2 marks n done",
      () => leaseFencing("succeeds")
    );

    dbTest.effect(
      "lease fencing: W1 paused past its lease cannot mark the delivery failed; n+1 is claimed only after W2 marks n done",
      () => leaseFencing("fails")
    );

    dbTest.effect(
      "lease fencing: the writes of a record effect whose lease was lost roll back; the delivery's write commits once",
      () => recordFencing
    );

    dbTest.effect(
      "two updates to one record with the first delivery failing twice: version n arrives strictly before n+1 while other records continue",
      () => failingTwice
    );

    dbTest.effect(
      "dead letter under block: later versions wait, a non-admin cannot act, and discarding releases them",
      () => blockPolicy
    );

    dbTest.effect(
      "dead letter under skip: later versions proceed, and a retried dead delivery arrives after them",
      () => skipPolicy
    );

    dbTest.effect(
      "a delete delivery to a non-admin identity carries the before image filtered for that identity",
      () => deletePayload
    );

    dbTest.effect(
      "an update's payload is its version's own image, not the record's state when the delivery runs",
      () => ownImage
    );

    dbTest.effect(
      "secrets never appear in payloads, neither as values nor as changed markers",
      () => secretCanary
    );

    dbTest.effect(
      "local reserved subscription identities fail without invoking the effect and reach dead letters",
      () => reservedIdentity
    );

    dbTest.effect(
      "a missing or inactive identity fails the attempt without running the effect",
      () => inactiveIdentity
    );

    dbTest.effect(
      "done rows are deleted 7 days after they finished; dead rows stay",
      () => retention
    );

    dbTest.effect(
      "the worker interrupts an effect at its timeout, before its lease ends, and records the failure",
      () =>
        effectTimeout.pipe(
          Effect.provide(
            WorkerSettings.layerOf({
              effectTimeout: Duration.millis(300),
              leaseMargin: Duration.minutes(5),
            })
          )
        )
    );

    dbTest.effect(
      "a save's after-commit NOTIFY wakes the worker, which delivers without polling",
      () =>
        wakeUp.pipe(
          Effect.provide(
            WorkerSettings.layerOf({ pollInterval: Duration.hours(1) })
          )
        )
    );
  });
});
