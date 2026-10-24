import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { ACME } from "../../testing/src/acme-ids.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { eventIdOf } from "../src/events/event-id.ts";
import { DeliveryFailed } from "../src/outbox/delivery-failed.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { asObject, textOf, apiCallers } from "./api-support.ts";
import { killAndAwait } from "./cli-support.ts";
import { hubTestLayer, listener, register } from "./hub-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { asUser } from "./records-support.ts";
import { expireLease } from "./worker-support.ts";
import {
  create as createAsset,
  patch as patchAsset,
} from "./writes-support.ts";

const CHILD = fileURLToPath(
  new URL("fixtures/hub-worker-child.ts", import.meta.url)
);

// The alias remains Effect-aware and lets Sonar recognize the test file.
const test = it.effect;

describe("hub-soak", () => {
  test("event identifiers follow the standard UUIDv5 namespace and name vector", () =>
    Effect.sync(() => {
      assert.strictEqual(
        eventIdOf("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
        "2ed6657d-e927-568b-95e1-2665a8aea6a2"
      );
    }));
  it.effect(
    "eight workers recover a process killed mid-delivery, retry 20 percent failures, preserve order and eventId, and never deliver rollback",
    () =>
      Effect.gen(function* scenario1() {
        const sql = yield* SqlClient.SqlClient;
        const database = yield* TestDatabase;
        const { admin } = yield* apiCallers;
        const received = yield* Deferred.make<boolean>();
        let stalled = true;
        const attempted = new Set<string>();

        const callback = yield* listener((call, response) => {
          if (stalled) {
            Deferred.doneUnsafe(received, Effect.succeed(true));

            return;
          }

          const id = textOf(call.body.eventId);

          const firstAttempt = !attempted.has(id);
          attempted.add(id);
          response.writeHead(
            firstAttempt && attempted.size % 5 === 0 ? 503 : 204
          );
          response.end();
        });

        const hub = yield* register(
          admin.token ?? "",
          `${callback.origin}/events`
        );

        const first = yield* createAsset(admin.token ?? "", "acme.asset", {
          name: "crash-first",
          status: "in_use",
        });

        const firstId = textOf(asObject(first.json).id);

        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn(process.execPath, [CHILD], {
              env: {
                ...process.env,
                STD_DATABASE_DIRECT_URL: database.url,
                STD_DATABASE_URL: database.url,
                STD_HUB_ALLOW_PRIVATE_ADDRESSES: "true",
              },
              stdio: "ignore",
            })
          ),
          killAndAwait
        );

        yield* Deferred.await(received).pipe(Effect.timeout("20 seconds"));
        yield* killAndAwait(child);
        stalled = false;
        yield* expireLease(hub, firstId, 1);

        const recordIds = [firstId];

        for (const index of [1, 2, 3, 4, 5, 6, 7]) {
          const created = yield* createAsset(admin.token ?? "", "acme.asset", {
            name: `soak-${index}`,
            status: "in_use",
          });

          assert.strictEqual(created.status, 201, created.text);
          recordIds.push(textOf(asObject(created.json).id));
        }

        for (const id of recordIds) {
          for (const version of [1, 2]) {
            const response = yield* patchAsset(
              admin.token ?? "",
              "acme.asset",
              id,
              version,
              { name: `soak-${id}-${version}` }
            );

            assert.strictEqual(response.status, 200, response.text);
          }
        }

        const transactions = yield* Transactions;
        yield* transactions
          .request(
            Effect.gen(function* scenario2() {
              yield* createRecord({
                body: { name: "rolled-back-hub", status: "in_use" },
                endpointClassId: ACME.asset,
              });

              return yield* new DeliveryFailed({ reason: "Test rollback" });
            }).pipe(asUser("1970f1d9-a830-4414-ba8e-210e07952a85"))
          )
          .pipe(Effect.exit);

        const retryWave = Effect.gen(function* retryWave() {
          yield* sql`UPDATE core.delivery SET next_attempt_at = now() WHERE subscription_id = ${hub}::uuid AND status = 'pending'`;
          yield* Effect.all(
            Array.from({ length: 8 }, () => workerPass()),
            {
              concurrency: 8,
            }
          );
        });

        yield* retryWave.pipe(
          Effect.repeat({
            times: 100,
            while: () =>
              deliveriesWhere(
                "subscription_id = $1::uuid AND status IN ('pending', 'running')",
                [hub]
              ).pipe(Effect.map((rows) => rows.length > 0)),
          })
        );

        const deliveries = yield* deliveriesWhere(
          "subscription_id = $1::uuid",
          [hub]
        );

        assert.lengthOf(deliveries, 24);
        assert.isTrue(deliveries.every((row) => row.status === "done"));
        const versions = new Map<string, number>();
        const eventIds = new Map<string, string>();

        // Each event's own eventId is its Idempotency-Key (decision 0035).
        for (const call of callback.calls) {
          assert.strictEqual(call.idempotencyKey, textOf(call.body.eventId));

          const row = deliveries.find(
            (candidate) =>
              eventIdOf(candidate.change_id, textOf(call.body.eventType)) ===
              call.idempotencyKey
          );

          assert.isDefined(row, "no rolled-back change reaches the listener");

          if (row === undefined) {
            continue;
          }

          const version = Number(row.record_version);
          assert.isAtLeast(version, versions.get(row.record_id) ?? 0);
          versions.set(row.record_id, version);
          const eventId = textOf(call.body.eventId);
          assert.strictEqual(
            eventIds.get(row.change_id) ?? eventId,
            eventId,
            "same change, same eventId across a crash or failure"
          );
          eventIds.set(row.change_id, eventId);
        }

        assert.strictEqual(eventIds.size, 24);
        assert.isAbove(
          callback.calls.length,
          24,
          "at least once includes crash and failure retries"
        );

        const rollbackRows =
          yield* sql`SELECT id::text AS id FROM acme.asset WHERE name = 'rolled-back-hub'`.pipe(
            Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String })))
          );

        assert.deepStrictEqual(rollbackRows, []);
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive),
    { timeout: 60_000 }
  );
});
