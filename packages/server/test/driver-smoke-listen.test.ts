import { PgClient } from "@effect/sql-pg";
/**
 * Plan 0A driver smoke test, part 3: LISTEN/NOTIFY with reconnect, and the
 * debounced worker wake-up sent after commit.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Queue, Stream } from "effect";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import { bumpRevision } from "../src/sql/config-commit.ts";
import {
  configSignals,
  LISTEN_BASE_DELAY,
  LISTEN_MAX_DELAY,
} from "../src/sql/config-listener.ts";
import type { ConfigSignal } from "../src/sql/config-listener.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  WAKE_UP_INTERVAL,
  wakeWorkerAfterCommit,
  WORKER_CHANNEL,
} from "../src/sql/wake-up.ts";
import { changeSetId } from "./support.ts";

const SIGNAL_TIMEOUT = Duration.seconds(10);

const nextSignal = (signals: Queue.Dequeue<ConfigSignal>) =>
  Queue.take(signals).pipe(Effect.timeout(SIGNAL_TIMEOUT));

const commitRevision = Transactions.pipe(
  Effect.flatMap(({ configCommit }) =>
    configCommit(bumpRevision(changeSetId()))
  )
);

describe("driver-smoke-listen", () => {
  it("the listener backs off from 100 ms to at most 5 s, and wake-ups are 250 ms apart", () => {
    assert.deepStrictEqual(
      [LISTEN_BASE_DELAY, LISTEN_MAX_DELAY, WAKE_UP_INTERVAL].map((delay) =>
        Duration.toMillis(delay)
      ),
      [100, 5000, 250]
    );
  });

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "LISTEN std_config delivers commits and reconnects after pg_terminate_backend",
      () =>
        Effect.scoped(
          Effect.gen(function* listenWithReconnect() {
            const database = yield* TestDatabase;
            const signals = yield* Queue.unbounded<ConfigSignal>();
            yield* Effect.forkScoped(
              configSignals.pipe(
                Stream.runForEach((signal) => Queue.offer(signals, signal))
              )
            );

            const listening = yield* nextSignal(signals);
            assert.strictEqual(listening.reason, "listening");

            const first = yield* commitRevision;
            const notified = yield* nextSignal(signals);
            assert.deepStrictEqual(notified, {
              reason: "notified",
              state: first,
            });

            const killer = yield* database.session("smoke-listener-killer");

            const killed = yield* killer.query(
              `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
               WHERE datname = current_database() AND query LIKE 'LISTEN %'`
            );

            assert.lengthOf(killed.rows, 1);

            const relistened = yield* nextSignal(signals);
            assert.deepStrictEqual(relistened, {
              reason: "listening",
              state: first,
            });

            const second = yield* commitRevision;
            assert.strictEqual(second.revision, first.revision + 1);

            const afterReconnect = yield* nextSignal(signals);
            assert.deepStrictEqual(afterReconnect, {
              reason: "notified",
              state: second,
            });
          })
        )
    );

    dbTest.effect(
      "worker wake-ups are sent after commit, never inside the transaction or on rollback",
      () =>
        Effect.scoped(
          Effect.gen(function* wakeUpAfterCommit() {
            const client = yield* PgClient.PgClient;
            const { request } = yield* Transactions;
            const wakeups = yield* client.listen(WORKER_CHANNEL);

            yield* request(
              Effect.gen(function* registerInsideTransaction() {
                yield* wakeWorkerAfterCommit;
                yield* Effect.sleep(Duration.millis(300));
                assert.strictEqual(
                  yield* Queue.size(wakeups),
                  0,
                  "nothing is sent before commit"
                );
              })
            );

            const delivered = yield* Queue.take(wakeups).pipe(
              Effect.timeout(SIGNAL_TIMEOUT)
            );

            assert.strictEqual(delivered.channel, WORKER_CHANNEL);

            yield* Effect.exit(
              request(
                wakeWorkerAfterCommit.pipe(
                  Effect.andThen(Effect.fail("rolled back" as const))
                )
              )
            );
            yield* Effect.sleep(Duration.millis(400));
            assert.strictEqual(
              yield* Queue.size(wakeups),
              0,
              "nothing on rollback"
            );

            // A burst of commits inside one 250 ms window: one wake-up at
            // once, one at the end of the window.
            yield* Effect.sleep(WAKE_UP_INTERVAL);
            const started = Date.now();

            for (let index = 0; index < 10; index += 1) {
              yield* request(wakeWorkerAfterCommit);
            }

            const burst = Date.now() - started;
            yield* Effect.sleep(Duration.millis(700));
            const sent = yield* Queue.size(wakeups);

            assert.isAtLeast(sent, 1);
            assert.isAtMost(sent, Math.ceil(burst / 250) + 2);
            assert.isAtMost(sent, 3, `burst of ${burst} ms`);
          })
        )
    );
  });
});
