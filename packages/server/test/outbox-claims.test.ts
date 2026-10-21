/**
 * The outbox claim at SQL level (Contracts 4.6, 4.7 and their acceptance
 * tests; plan gate 1E): per-record version order across transactions, the
 * sequence-cursor regression, expired leases, fencing, dead letters under
 * `block` and `skip`, backoff, and the partial index behind the claim.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Deferred, Duration, Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  claimDeliveries,
  claimStatement,
  LAST_ERROR_MAX_LENGTH,
  LEASE_EXPIRED_ERROR,
  markDone,
  markFailed,
  RETRY_CAP,
  retryDelay,
} from "../src/outbox/delivery-claims.ts";
import type {
  ClaimedDelivery,
  DeadLetterPolicy,
} from "../src/outbox/delivery-claims.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  deliveriesOf,
  deliveriesWhere,
  outboxTestLayer,
  subscribe,
} from "./outbox-support.ts";
import { setUpAcme } from "./records-support.ts";
import { ACME, values } from "./schema-support.ts";
import { refusalOf } from "./support.ts";

const LEASE = Duration.minutes(5);

const claim = (
  subscriptionId: string,
  deadLetter: DeadLetterPolicy = "block",
  maxAttempts = 10
) =>
  claimDeliveries({
    deadLetter,
    lease: LEASE,
    limit: 50,
    maxAttempts,
    subscriptionId,
  });

const keys = (claimed: readonly ClaimedDelivery[]) =>
  claimed.map((row) => `${row.recordId}:${row.recordVersion}`);

const createAsset = (name: string) =>
  createRecord({
    body: { name, status: "in_use" },
    endpointClassId: ACME.asset,
  });

// Each call is its own request transaction.
const rename = (id: string, version: number, name: string) =>
  updateRecord({
    body: { name },
    endpointClassId: ACME.asset,
    expectedVersion: version,
    id,
  });

// One subscription's row for a record.
const rowOf = (recordId: string, subscriptionId: string) =>
  deliveriesWhere("record_id = $1::uuid AND subscription_id = $2::uuid", [
    recordId,
    subscriptionId,
  ]).pipe(Effect.map(([row]) => row));

const only = <A>(items: readonly A[]): A => {
  const [item] = items;

  if (item === undefined || items.length !== 1) {
    throw new Error(`expected one item, got ${items.length}`);
  }

  return item;
};

// Whether every row of `lower` has a smaller row ID than every row of `higher`.
const allBelow = (
  lower: readonly { readonly id: string }[],
  higher: readonly { readonly id: string }[]
): boolean =>
  lower.every((row) =>
    higher.every((other) => BigInt(row.id) < BigInt(other.id))
  );

// Table-owner edits that stand in for the passage of time.
const setDelivery = (assignment: string, id: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(`UPDATE core.delivery SET ${assignment} WHERE id = $1::int8`, [
        id,
      ])
    )
  );

// The worker holding the lease stalls past it.
const expireLease = (id: string) =>
  setDelivery("lease_until = now() - interval '1 second'", id);

const decodePlan = decodeRows(Schema.Struct({ "QUERY PLAN": Schema.String }));

// The claim's plan for actual parameters.
const explainClaim = (policy: DeadLetterPolicy, subscription: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(`EXPLAIN (COSTS OFF) ${claimStatement(policy)}`, [
        subscription,
        "10",
        "300000 milliseconds",
      ])
    ),
    Effect.flatMap(decodePlan),
    Effect.map((rows) => rows.map((row) => row["QUERY PLAN"]))
  );

// Finished or pending deliveries on fresh change entries, as table owner.
const bulkDeliveries = (subscription: string, status: string, count: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `WITH c AS (
           INSERT INTO core."change" (id, class_id, version, created_at,
             created_by, updated_at, updated_by, operation_id, record_id,
             record_class_id, record_version, kind, actor_id, cause,
             schema_revision, occurred_at, fields)
           SELECT uuidv7(), $1::uuid, 1, now(), $2::uuid, now(), $2::uuid,
             uuidv7(), uuidv7(), $3::uuid, 1, 'create', $2::uuid,
             '{"kind":"system"}', 0, now(), '{}'
           FROM generate_series(1, $4::int4)
           RETURNING id, record_id)
         INSERT INTO core.delivery (subscription_id, change_id, record_id,
           record_version, status, attempts, next_attempt_at)
         SELECT $5::uuid, c.id, c.record_id, 1, $6::text, 0, now() FROM c`,
        [
          PLATFORM_CLASS_IDS.change,
          SYSTEM_USER_ID,
          ACME.asset,
          String(count),
          subscription,
          status,
        ]
      )
    )
  );

describe("outbox-claims", () => {
  it("backs off from 10 s, doubling to 1 h, minus at most 20 % jitter", () => {
    assert.strictEqual(Duration.toMillis(retryDelay(1, 0)), 10_000);
    assert.strictEqual(Duration.toMillis(retryDelay(2, 0)), 20_000);
    assert.strictEqual(Duration.toMillis(retryDelay(9, 0)), 2_560_000);
    assert.strictEqual(
      Duration.toMillis(retryDelay(10, 0)),
      Duration.toMillis(RETRY_CAP)
    );
    assert.strictEqual(
      Duration.toMillis(retryDelay(1000, 0)),
      Duration.toMillis(RETRY_CAP)
    );
    assert.strictEqual(Duration.toMillis(retryDelay(1, 0.5)), 9000);
    assert.isAtLeast(Duration.toMillis(retryDelay(1, 0.999999)), 8000);
  });

  layer(outboxTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "claim order: n+1 is not claimable until n is done, while other records stay claimable",
      () =>
        Effect.gen(function* claimOrder() {
          const subscription = yield* subscribe({
            classId: ACME.asset,
            operations: ["update"],
          });

          const r = yield* createAsset("R");
          const q = yield* createAsset("Q");

          // Two updates of R in two transactions, one of Q.
          yield* rename(r.id, 1, "R2");
          yield* rename(r.id, 2, "R3");
          yield* rename(q.id, 1, "Q2");

          const first = yield* claim(subscription);

          assert.deepStrictEqual(keys(first), [`${r.id}:2`, `${q.id}:2`]);
          assert.deepStrictEqual(yield* claim(subscription), [], "R3 waits");

          yield* markDone(only(first.filter((row) => row.recordId === r.id)));

          assert.deepStrictEqual(keys(yield* claim(subscription)), [
            `${r.id}:3`,
          ]);
        })
    );

    dbTest.effect(
      "sequence-cursor regression: A's delivery row exists and is claimable after A commits, for every matching subscription",
      () =>
        Effect.gen(function* sequenceCursor() {
          const { request } = yield* Transactions;

          const first = yield* subscribe({
            classId: ACME.asset,
            operations: ["create"],
          });

          const second = yield* subscribe({
            classId: ACME.laptop,
            operations: ["create"],
          });

          const written = yield* Deferred.make<string>();
          const release = yield* Deferred.make<boolean>();

          // A creates a laptop, which both subscriptions match, then holds
          // its transaction open.
          const a = yield* request(
            Effect.gen(function* transactionA() {
              const created = yield* createRecord({
                body: { name: "A", purchased_on: "2026-02-01" },
                endpointClassId: ACME.laptop,
              });

              yield* Deferred.succeed(written, created.id);
              yield* Deferred.await(release);

              return created.id;
            })
          ).pipe(Effect.forkChild);

          const aId = yield* Deferred.await(written);

          // B starts after A wrote, takes later row IDs, and commits first.
          const b = yield* createRecord({
            body: { name: "B", purchased_on: "2026-02-02" },
            endpointClassId: ACME.laptop,
          });

          assert.deepStrictEqual(keys(yield* claim(first)), [`${b.id}:1`]);

          yield* Deferred.succeed(release, true);
          assert.strictEqual(yield* Fiber.join(a), aId);

          const aRows = yield* deliveriesOf(aId);
          const bRows = yield* deliveriesOf(b.id);

          assert.lengthOf(aRows, 2, "one row per matching subscription");
          assert.isTrue(
            allBelow(aRows, bRows),
            "A's rows have lower IDs than B's"
          );

          assert.deepStrictEqual(keys(yield* claim(first)), [`${aId}:1`]);
          assert.deepStrictEqual(keys(yield* claim(second)), [
            `${aId}:1`,
            `${b.id}:1`,
          ]);
        })
    );

    dbTest.effect(
      "an expired lease is claimable again under a new token; the stale token's done and failure change nothing",
      () =>
        Effect.gen(function* expiredLease() {
          const subscription = yield* subscribe({
            classId: ACME.asset,
            operations: ["create"],
          });

          const created = yield* createAsset("leased");
          const stale = only(yield* claim(subscription));

          assert.strictEqual(stale.attempts, 1);
          assert.deepStrictEqual(yield* claim(subscription), [], "leased");

          yield* expireLease(stale.id);

          const fresh = only(yield* claim(subscription));

          assert.strictEqual(fresh.id, stale.id);
          assert.notStrictEqual(fresh.leaseToken, stale.leaseToken);
          assert.strictEqual(fresh.attempts, 2);

          const lateDone = yield* Effect.flip(markDone(stale));

          const lateFailure = yield* Effect.flip(
            markFailed(stale, { error: "late", maxAttempts: 10 })
          );

          assert.strictEqual(lateDone._tag, "LeaseLost");
          assert.strictEqual(lateFailure._tag, "LeaseLost");

          const row = yield* rowOf(created.id, subscription);

          assert.strictEqual(row?.status, "in_flight");
          assert.strictEqual(row?.lease_token, fresh.leaseToken);
          assert.isNull(row?.last_error);

          yield* markDone(fresh);

          const done = yield* rowOf(created.id, subscription);

          assert.strictEqual(done?.status, "done");
          assert.isNull(done?.lease_token);

          const again = yield* Effect.flip(markDone(fresh));

          assert.strictEqual(again._tag, "LeaseLost", "done is final");
        })
    );

    dbTest.effect(
      "a lost lease inside a delivery transaction rolls back the effect's record writes",
      () =>
        Effect.gen(function* deliveryTransaction() {
          const { request } = yield* Transactions;

          const subscription = yield* subscribe({
            classId: ACME.laptop,
            operations: ["create"],
          });

          yield* createRecord({
            body: { name: "source", purchased_on: "2026-03-01" },
            endpointClassId: ACME.laptop,
          });

          const target = yield* createAsset("target");
          const stale = only(yield* claim(subscription));

          yield* expireLease(stale.id);
          only(yield* claim(subscription));

          const failed = yield* request(
            Effect.gen(function* effectThenDone() {
              yield* rename(target.id, 1, "written by the effect");
              yield* markDone(stale);
            })
          ).pipe(Effect.flip);

          assert.strictEqual(failed._tag, "LeaseLost");
          assert.deepStrictEqual(
            yield* values(
              "SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid",
              [target.id]
            ),
            ["1"],
            "the effect's write rolled back"
          );
        })
    );

    dbTest.effect(
      "a failure returns the row to pending with backoff, and the last attempt makes it dead",
      () =>
        Effect.gen(function* failures() {
          const subscription = yield* subscribe({
            classId: ACME.asset,
            maxAttempts: 2,
            operations: ["create"],
          });

          const created = yield* createAsset("failing");
          const firstClaim = only(yield* claim(subscription));

          assert.strictEqual(
            yield* markFailed(firstClaim, { error: "timeout", maxAttempts: 2 }),
            "pending"
          );

          const pending = yield* rowOf(created.id, subscription);

          assert.strictEqual(pending?.status, "pending");
          assert.strictEqual(pending?.last_error, "timeout");
          assert.isNull(pending?.lease_token);
          assert.deepStrictEqual(yield* claim(subscription), [], "backing off");

          const delay = yield* values(
            `SELECT round(extract(epoch FROM next_attempt_at - now()))::text AS value
             FROM core.delivery WHERE id = $1::int8`,
            [firstClaim.id]
          );

          assert.include(["8", "9", "10"], delay[0]);

          yield* setDelivery("next_attempt_at = now()", firstClaim.id);

          const secondClaim = only(yield* claim(subscription));

          assert.strictEqual(secondClaim.attempts, 2);
          assert.strictEqual(
            yield* markFailed(secondClaim, {
              error: "x".repeat(LAST_ERROR_MAX_LENGTH * 2),
              maxAttempts: 2,
            }),
            "dead"
          );

          const dead = yield* rowOf(created.id, subscription);

          assert.strictEqual(dead?.status, "dead");
          assert.lengthOf(dead?.last_error ?? "", LAST_ERROR_MAX_LENGTH);
          assert.deepStrictEqual(yield* claim(subscription), []);
        })
    );

    dbTest.effect(
      "a dead row holds later versions back under block and lets them through under skip",
      () =>
        Effect.gen(function* deadLetters() {
          const policies = {
            block: yield* subscribe({
              classId: ACME.asset,
              deadLetter: "block",
              maxAttempts: 1,
              operations: ["update"],
            }),
            skip: yield* subscribe({
              classId: ACME.asset,
              deadLetter: "skip",
              maxAttempts: 1,
              operations: ["update"],
            }),
          };

          const r = yield* createAsset("R");
          const other = yield* createAsset("other");

          yield* rename(r.id, 1, "R2");
          yield* rename(r.id, 2, "R3");

          for (const policy of ["block", "skip"] as const) {
            const r2 = only(yield* claim(policies[policy], policy));

            assert.strictEqual(r2.recordVersion, 2);
            assert.strictEqual(
              yield* markFailed(r2, { error: "gone", maxAttempts: 1 }),
              "dead"
            );
          }

          yield* rename(other.id, 1, "other2");

          assert.deepStrictEqual(
            keys(yield* claim(policies.block, "block")),
            [`${other.id}:2`],
            "R3 waits behind the dead R2; other records flow"
          );
          assert.deepStrictEqual(keys(yield* claim(policies.skip, "skip")), [
            `${r.id}:3`,
            `${other.id}:2`,
          ]);
        })
    );

    dbTest.effect(
      "a row reclaimed max_attempts times without a reported failure ends dead, under block and under skip",
      () =>
        Effect.gen(function* crashedAttempts() {
          const policies = {
            block: yield* subscribe({
              classId: ACME.asset,
              deadLetter: "block",
              maxAttempts: 2,
              operations: ["update"],
            }),
            skip: yield* subscribe({
              classId: ACME.asset,
              deadLetter: "skip",
              maxAttempts: 2,
              operations: ["update"],
            }),
          };

          const r = yield* createAsset("crashing");

          yield* rename(r.id, 1, "crash 2");
          yield* rename(r.id, 2, "crash 3");

          for (const policy of ["block", "skip"] as const) {
            const subscription = policies[policy];

            // Two claims whose workers die without reporting.
            for (const attempt of [1, 2]) {
              const claimed = only(yield* claim(subscription, policy, 2));

              assert.strictEqual(claimed.recordVersion, 2);
              assert.strictEqual(claimed.attempts, attempt);
              yield* expireLease(claimed.id);
            }

            const after = yield* claim(subscription, policy, 2);

            const dead = yield* deliveriesWhere(
              "record_id = $1::uuid AND subscription_id = $2::uuid AND record_version = 2",
              [r.id, subscription]
            );

            assert.strictEqual(dead[0]?.status, "dead");
            assert.strictEqual(dead[0]?.attempts, 2);
            assert.isNull(dead[0]?.lease_token);
            assert.strictEqual(dead[0]?.last_error, LEASE_EXPIRED_ERROR);
            assert.deepStrictEqual(
              keys(after),
              policy === "block" ? [] : [`${r.id}:3`],
              policy === "block"
                ? "the dead version 2 holds version 3 back"
                : "version 3 proceeds past the dead version 2"
            );
          }
        })
    );

    dbTest.effect(
      "a claim commits on its own: it refuses to join a transaction",
      () =>
        Effect.gen(function* nested() {
          const { request } = yield* Transactions;
          const subscription = yield* subscribe({ classId: ACME.asset });
          const exit = yield* Effect.exit(request(claim(subscription)));

          assert.strictEqual(refusalOf(exit)?.reason, "nesting");
        })
    );

    dbTest.effect(
      "the claim uses the partial index on (subscription, record, version)",
      () =>
        Effect.gen(function* partialIndex() {
          const sql = yield* SqlClient.SqlClient;

          const busy = yield* subscribe({
            classId: ACME.asset,
            name: "busy_one",
          });

          const quiet = yield* subscribe({
            classId: ACME.asset,
            name: "quiet_one",
          });

          // 2,000 finished deliveries per subscription, 20 pending ones.
          yield* bulkDeliveries(busy, "done", 2000);
          yield* bulkDeliveries(quiet, "done", 2000);
          yield* bulkDeliveries(busy, "pending", 20);
          yield* sql`ANALYZE core.delivery`;

          for (const policy of ["block", "skip"] as const) {
            const plan = yield* explainClaim(policy, busy);

            assert.isTrue(
              plan.some((line) => line.includes("delivery_order")),
              plan.join("\n")
            );
            assert.isFalse(
              plan.some((line) => line.includes("Seq Scan on delivery")),
              plan.join("\n")
            );
          }

          assert.lengthOf(
            yield* deliveriesWhere(
              "subscription_id = $1::uuid AND status = 'pending'",
              [busy]
            ),
            20
          );
        })
    );
  });
});
