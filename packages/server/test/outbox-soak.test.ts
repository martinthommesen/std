/**
 * The delivery soak (Contracts 4.6, 4.7, acceptance test "Soak"; plan gate
 * 3B): 8 workers, 10,000 deliveries over 500 records. Every delivery ends
 * `done`, exactly once; never two `in_flight` rows for one subscription and
 * record, and never two effects of one record running at once; each
 * record's versions arrive in order.
 *
 * The 8 workers are full worker loops (`runWorker`: LISTEN, polling,
 * housekeeping) in this process, each on the shared pool. The changes are
 * written as table owner, 500 records per version in one transaction per
 * version, so version n of every record commits before n+1, as the
 * root-row lock makes saves do; workers start before the first version and
 * catch up while the later ones are written. The effect is external and
 * instant, so the test measures the outbox and not an effect.
 *
 * Determinism: completion is awaited by condition (with a generous
 * deadline for slow CI runners), never by sleeping, and every check holds
 * for every interleaving.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Duration, Effect, Fiber, Ref, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { DeliveryFailed } from "../src/outbox/delivery-failed.ts";
import { runWorker } from "../src/outbox/worker.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { subscribe } from "./outbox-support.ts";
import { ACME, freshId } from "./schema-support.ts";
import { waitUntil } from "./support.ts";
import { serveOnly, workerTestLayer } from "./worker-support.ts";

const WORKERS = 8;
const RECORDS = 500;
const VERSIONS = 20;
const DELIVERIES = RECORDS * VERSIONS;

/** What the effect saw, per record. */
interface Observed {
  /** Versions in arrival order. */
  readonly arrivals: Map<string, number[]>;
  /** Records whose effect is running now. */
  readonly running: Set<string>;
  /** Effects that started while another of the same record ran. */
  overlaps: number;
}

const decodeCount = decodeRows(Schema.Struct({ n: Schema.Int }));

const count = (text: string, params: readonly unknown[]) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(text, params)),
    Effect.flatMap(decodeCount),
    Effect.map(([row]) => row?.n ?? 0)
  );

// One version of every record, with its change entries and delivery rows,
// committed in one statement.
const writeVersion = (
  subscriptionId: string,
  recordIds: readonly string[],
  version: number
) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `WITH c AS (
           INSERT INTO core."change" (id, class_id, version, created_at,
             created_by, updated_at, updated_by, operation_id, record_id,
             record_class_id, record_version, kind, actor_id, cause,
             schema_revision, occurred_at, fields)
           SELECT uuidv7(), $1::uuid, 1, now(), $2::uuid, now(), $2::uuid,
             uuidv7(), r.id, $3::uuid, $4::int8, $5::text, $2::uuid,
             '{"kind":"system"}', 0, now(), '{}'
           FROM unnest($6::uuid[]) AS r (id)
           RETURNING id, record_id)
         INSERT INTO core.delivery (subscription_id, change_id, record_id,
           record_version, status, attempts, next_attempt_at)
         SELECT $7::uuid, c.id, c.record_id, $4::int8, 'pending', 0, now()
         FROM c`,
        [
          PLATFORM_CLASS_IDS.change,
          SYSTEM_USER_ID,
          ACME.asset,
          String(version),
          version === 1 ? "create" : "update",
          [...recordIds],
          subscriptionId,
        ]
      )
    )
  );

// Records the arrival; an effect of a record that is already running is an
// overlap, which the claim predicate must make impossible.
const observe = (observed: Observed) => (delivery: Delivery) =>
  Effect.gen(function* observeDelivery() {
    if (observed.running.has(delivery.recordId)) {
      observed.overlaps += 1;
    }

    observed.running.add(delivery.recordId);
    yield* Effect.yieldNow;
    observed.running.delete(delivery.recordId);

    if (delivery.payload.recordVersion !== delivery.recordVersion) {
      return yield* new DeliveryFailed({
        reason: "payload of another version",
      });
    }

    const versions = observed.arrivals.get(delivery.recordId) ?? [];

    versions.push(delivery.recordVersion);
    observed.arrivals.set(delivery.recordId, versions);

    return yield* Effect.void;
  });

const soak = Effect.gen(function* soakTest() {
  const fixture = yield* AcmeFixture;
  const recordIds = Array.from({ length: RECORDS }, () => freshId());
  const doubleInFlight = yield* Ref.make(0);
  const samples = yield* Ref.make(0);

  const observed: Observed = {
    arrivals: new Map(),
    overlaps: 0,
    running: new Set(),
  };

  const subscription = yield* subscribe({
    classId: ACME.asset,
    identityId: fixture.admin.id,
  });

  yield* serveOnly(subscription, { kind: "external", run: observe(observed) });

  // Forked from this fiber: a fiber forked inside a concurrent forEach
  // would end with the forEach's own fiber.
  const workers: Fiber.Fiber<never, unknown>[] = [];

  for (let worker = 0; worker < WORKERS; worker += 1) {
    workers.push(yield* Effect.forkChild(runWorker));
  }

  // Never two in_flight rows of one subscription and record.
  const sampler = yield* count(
    `SELECT count(*)::int AS n FROM (
       SELECT record_id FROM core.delivery
       WHERE subscription_id = $1::uuid AND status = 'in_flight'
       GROUP BY record_id HAVING count(*) > 1) AS doubled`,
    [subscription]
  ).pipe(
    Effect.flatMap((doubled) =>
      Ref.update(doubleInFlight, (n) => n + doubled).pipe(
        Effect.andThen(Ref.update(samples, (n) => n + 1))
      )
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(10))),
    Effect.forkChild
  );

  for (let version = 1; version <= VERSIONS; version += 1) {
    yield* writeVersion(subscription, recordIds, version);
  }

  yield* waitUntil(
    count(
      "SELECT count(*)::int AS n FROM core.delivery WHERE subscription_id = $1::uuid AND status = 'done'",
      [subscription]
    ).pipe(Effect.map((done) => done === DELIVERIES)),
    Duration.minutes(4)
  );

  yield* Fiber.interrupt(sampler);
  yield* Fiber.interruptAll(workers);

  assert.strictEqual(
    yield* count(
      "SELECT count(*)::int AS n FROM core.delivery WHERE subscription_id = $1::uuid AND status <> 'done'",
      [subscription]
    ),
    0,
    "all done"
  );
  assert.isAbove(yield* Ref.get(samples), 0, "the sampler ran");
  assert.strictEqual(yield* Ref.get(doubleInFlight), 0, "never two in flight");
  assert.strictEqual(observed.overlaps, 0, "never two effects of one record");

  const expected = Array.from({ length: VERSIONS }, (_, index) => index + 1);

  const outOfOrder = recordIds.filter(
    (id) =>
      JSON.stringify(observed.arrivals.get(id)) !== JSON.stringify(expected)
  );

  assert.deepStrictEqual(outOfOrder, [], "every record: 1..20, in order, once");
});

describe("outbox-soak", () => {
  it("runs at the size the contract names: 8 workers, 10,000 deliveries over 500 records", () => {
    assert.strictEqual(WORKERS, 8);
    assert.strictEqual(DELIVERIES, 10_000);
    assert.strictEqual(RECORDS, 500);
    assert.isAbove(VERSIONS, 9, "two-digit versions, which sort wrong as text");
  });

  layer(
    workerTestLayer(
      { batchSize: 32, pollInterval: Duration.millis(100) },
      { maxConnections: 48 }
    ),
    { excludeTestServices: true }
  )((dbTest) => {
    dbTest.effect(
      "8 workers deliver 10,000 deliveries over 500 records: all done, never two in flight for one record, version order holds",
      () => soak,
      { timeout: 300_000 }
    );
  });
});
