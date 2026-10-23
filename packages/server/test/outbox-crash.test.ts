/**
 * Crash before `done` (Contracts 4.1 "After-commit effects", 4.6, 4.7,
 * acceptance test "Crash before done"; plan gate 3B): a worker process is
 * killed with SIGKILL right after its effect and before the fenced `done`.
 *
 * - A record-service effect wrote a record in its delivery transaction;
 *   the kill rolls that transaction back with the missing `done`, so the
 *   rerun writes the record once: zero duplicate writes.
 * - An external effect called its system; the rerun calls it again with
 *   the same `change_id`, its idempotency key.
 *
 * The worker is a child process (`fixtures/worker-child.ts`) that prints
 * when it has done its effect and then stalls. The test kills it there,
 * waits until Postgres has dropped its session, lets its lease run out
 * (a table-owner edit stands in for time), and reruns the delivery in this
 * process with the same effect minus the stall. A test effect stands in for
 * the after-commit rules that workstream 3A adds.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assert, describe, it, layer } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";
import type { Scope } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import type {
  Delivery,
  DeliveryEffect,
} from "../src/outbox/delivery-effects.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { killAndAwait } from "./cli-support.ts";
import { WORKER_CHILD_APPLICATION_NAME } from "./fixtures/worker-child-name.ts";
import { deliveriesWhere, subscribe } from "./outbox-support.ts";
import { values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";
import {
  createAsset,
  expireLease,
  serveOnly,
  updateAsset,
  workerTestLayer,
} from "./worker-support.ts";

const CHILD_SCRIPT = fileURLToPath(
  new URL("fixtures/worker-child.ts", import.meta.url)
);

const PAUSED = /PAUSED (?<changeId>\S+)/u;

const CALL = /CALL (?<changeId>\S+)/gu;

/** A running child worker. */
interface ChildWorker {
  readonly child: ChildProcess;
  /** Completes with the change ID once the child stalls after its effect. */
  readonly paused: Deferred.Deferred<string>;
  /** Its standard output so far. */
  readonly output: () => string;
}

/**
 * Starts the child worker; it is killed when the scope closes.
 * @param url - The test database.
 * @param subscriptionId - The subscription it serves.
 * @param kind - Its effect.
 * @returns The process.
 */
const startChild = (
  url: string,
  subscriptionId: string,
  kind: DeliveryEffect["kind"]
): Effect.Effect<ChildWorker, never, Scope.Scope> =>
  Effect.gen(function* start() {
    const paused = yield* Deferred.make<string>();
    let output = "";

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [CHILD_SCRIPT], {
          env: {
            ...process.env,
            STD_DATABASE_DIRECT_URL: url,
            STD_DATABASE_URL: url,
            STD_TEST_EFFECT: kind,
            STD_TEST_SUBSCRIPTION: subscriptionId,
          },
          stdio: ["ignore", "pipe", "inherit"],
        })
      ),
      killAndAwait
    );

    child.stdout?.on("data", (chunk: Uint8Array) => {
      output += String(chunk);

      const changeId = PAUSED.exec(output)?.groups?.changeId;

      if (changeId !== undefined) {
        Deferred.doneUnsafe(paused, Effect.succeed(changeId));
      }
    });

    return { child, output: () => output, paused };
  });

// No session of the killed child is left: Postgres has rolled back its
// open transaction.
const childGone = values(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = $1`,
  [WORKER_CHILD_APPLICATION_NAME]
).pipe(Effect.map(([count]) => count === "0"));

// Assets created by the effect for a change.
const effectWrites = (changeId: string) =>
  values(`SELECT id::text AS value FROM "acme"."asset" WHERE name = $1`, [
    `effect ${changeId}`,
  ]);

// The rerun's effects: the child's minus the stall.
const recordRerun: DeliveryEffect = {
  kind: "record",
  run: (delivery: Delivery) =>
    createRecord({
      body: { name: `effect ${delivery.changeId}`, status: "new" },
      cause: delivery.cause,
      endpointClassId: ACME.asset,
    }).pipe(Effect.asVoid),
};

const externalRerun = (calls: Ref.Ref<readonly string[]>): DeliveryEffect => ({
  kind: "external",
  run: (delivery: Delivery) =>
    Ref.update(calls, (all) => [...all, delivery.changeId]),
});

/**
 * Creates a watched asset, runs the child worker until it stalls after its
 * effect, and kills it there.
 * @param kind - The effect.
 * @returns The subscription, the asset, the change and the child's output.
 */
const crashAfterEffect = Effect.fn("CrashTest.crashAfterEffect")(
  function* crashAfterEffect(kind: DeliveryEffect["kind"]) {
    const fixture = yield* AcmeFixture;
    const database = yield* TestDatabase;

    const subscription = yield* subscribe({
      classId: ACME.asset,
      identityId: fixture.admin.id,
      operations: ["update"],
    });

    const id = yield* createAsset(fixture.admin.id, {
      name: `crash-${kind}`,
      status: "in_use",
    });

    yield* updateAsset(fixture.admin.id, id, 1, { name: `crash-${kind}-2` });

    const worker = yield* startChild(database.url, subscription, kind);
    const changeId = yield* Deferred.await(worker.paused);

    const [row] = yield* deliveriesWhere(
      "subscription_id = $1::uuid AND record_id = $2::uuid",
      [subscription, id]
    );

    assert.strictEqual(row?.change_id, changeId);
    assert.strictEqual(row?.status, "in_flight");

    yield* killAndAwait(worker.child);
    yield* waitUntil(childGone);

    return { changeId, id, output: worker.output(), subscription };
  }
);

const recordCrash = Effect.gen(function* recordCrashTest() {
  const { changeId, id, subscription } = yield* crashAfterEffect("record");

  assert.deepStrictEqual(
    yield* effectWrites(changeId),
    [],
    "the killed transaction's write is gone"
  );

  yield* expireLease(subscription, id, 2);
  yield* serveOnly(subscription, recordRerun);
  assert.strictEqual(yield* workerPass(), 1);

  const [row] = yield* deliveriesWhere(
    "subscription_id = $1::uuid AND record_id = $2::uuid",
    [subscription, id]
  );

  assert.strictEqual(row?.status, "done");
  assert.strictEqual(row?.attempts, 2);
  assert.lengthOf(yield* effectWrites(changeId), 1, "zero duplicate writes");

  // The lease is gone, so nothing runs it a third time.
  assert.strictEqual(yield* workerPass(), 0);
  assert.lengthOf(yield* effectWrites(changeId), 1);
}).pipe(Effect.scoped);

const externalCrash = Effect.gen(function* externalCrashTest() {
  const { changeId, id, output, subscription } =
    yield* crashAfterEffect("external");

  const calls = yield* Ref.make<readonly string[]>(
    [...output.matchAll(CALL)].map((match) => match.groups?.changeId ?? "")
  );

  assert.deepStrictEqual(yield* Ref.get(calls), [changeId], "the child called");

  yield* expireLease(subscription, id, 2);
  yield* serveOnly(subscription, externalRerun(calls));
  assert.strictEqual(yield* workerPass(), 1);

  assert.deepStrictEqual(
    yield* Ref.get(calls),
    [changeId, changeId],
    "the call repeats with the same change_id"
  );

  const [row] = yield* deliveriesWhere(
    "subscription_id = $1::uuid AND record_id = $2::uuid",
    [subscription, id]
  );

  assert.strictEqual(row?.status, "done");
}).pipe(Effect.scoped);

describe("outbox-crash", () => {
  it("the child prints the change ID it stalls on", () => {
    assert.strictEqual(
      PAUSED.exec("x\nPAUSED 0192f000-0000-7000-8000-00000000a11c\n")?.groups
        ?.changeId,
      "0192f000-0000-7000-8000-00000000a11c"
    );
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "crash before done: a worker killed after a record-service effect's write and before done; the rerun makes zero duplicate writes",
      () => recordCrash
    );

    dbTest.effect(
      "crash before done: a worker killed after an external call and before done; the rerun calls again with the same change_id",
      () => externalCrash
    );
  });
});
