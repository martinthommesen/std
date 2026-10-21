import { PgClient } from "@effect/sql-pg";
/**
 * Plan 0A driver smoke test, part 3: LISTEN/NOTIFY with reconnect, and the
 * debounced worker wake-up sent after commit.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Queue, Ref, Stream } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";

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
  makeWorkerWakeup,
  WAKE_UP_INTERVAL,
  wakeWorkerAfterCommit,
  WORKER_CHANNEL,
  WorkerWakeup,
} from "../src/sql/wake-up.ts";
import { changeSetId } from "./support.ts";

const SIGNAL_TIMEOUT = Duration.seconds(10);

const nextSignal = (signals: Queue.Dequeue<ConfigSignal>) =>
  Queue.take(signals).pipe(Effect.timeout(SIGNAL_TIMEOUT));

const notifyFailure = new SqlError({
  reason: new UnknownError({
    cause: new Error("connection lost"),
    message: "connection lost",
    operation: "notify",
  }),
});

/**
 * Lets forked wake-up fibers whose sleep is due run.
 * @param millis - How far to move the test clock.
 * @returns An effect that advances the clock and yields.
 */
const advance = (millis: number) =>
  TestClock.adjust(Duration.millis(millis)).pipe(
    Effect.andThen(Effect.yieldNow)
  );

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

  it.effect(
    "a burst of wake-ups sends one at once and one at the end of the window",
    () =>
      Effect.scoped(
        Effect.gen(function* debouncedBurst() {
          const sent = yield* Ref.make(0);

          const wakeup = yield* makeWorkerWakeup(
            Ref.update(sent, (n) => n + 1)
          );

          yield* wakeup.wake;
          yield* advance(0);
          assert.strictEqual(
            yield* Ref.get(sent),
            1,
            "the first wake-up is sent at once"
          );

          for (let index = 0; index < 10; index += 1) {
            yield* wakeup.wake;
          }

          yield* advance(249);
          assert.strictEqual(
            yield* Ref.get(sent),
            1,
            "nothing more inside the window"
          );

          yield* advance(1);
          assert.strictEqual(
            yield* Ref.get(sent),
            2,
            "one more at the end of the window"
          );

          yield* advance(1000);
          assert.strictEqual(
            yield* Ref.get(sent),
            2,
            "nothing without a new request"
          );
        })
      )
  );

  it.effect("a failed NOTIFY is logged and later wake-ups are still sent", () =>
    Effect.scoped(
      Effect.gen(function* failedNotify() {
        const tried = yield* Ref.make(0);

        const wakeup = yield* makeWorkerWakeup(
          Ref.update(tried, (n) => n + 1).pipe(
            Effect.andThen(Effect.fail(notifyFailure))
          )
        );

        yield* wakeup.wake;
        yield* advance(0);
        assert.strictEqual(yield* Ref.get(tried), 1);

        yield* wakeup.wake;
        yield* advance(250);
        assert.strictEqual(yield* Ref.get(tried), 2);
      })
    )
  );

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
      "worker wake-ups are requested after commit, never inside the transaction or on rollback",
      () =>
        Effect.gen(function* wakeUpAfterCommit() {
          const { request } = yield* Transactions;
          const requested = yield* Ref.make(0);

          const counting = WorkerWakeup.of({
            wake: Ref.update(requested, (n) => n + 1),
          });

          const register = wakeWorkerAfterCommit.pipe(
            Effect.provideService(WorkerWakeup, counting)
          );

          yield* request(
            Effect.gen(function* registerInsideTransaction() {
              yield* register;
              assert.strictEqual(
                yield* Ref.get(requested),
                0,
                "nothing is requested before commit"
              );
            })
          );

          assert.strictEqual(yield* Ref.get(requested), 1);

          yield* Effect.exit(
            request(
              register.pipe(Effect.andThen(Effect.fail("rolled back" as const)))
            )
          );

          assert.strictEqual(
            yield* Ref.get(requested),
            1,
            "nothing on rollback"
          );
        })
    );

    dbTest.effect("a wake-up after commit reaches LISTEN std_worker", () =>
      Effect.scoped(
        Effect.gen(function* wakeUpDelivered() {
          const client = yield* PgClient.PgClient;
          const { request } = yield* Transactions;
          const wakeups = yield* client.listen(WORKER_CHANNEL);

          yield* request(wakeWorkerAfterCommit);

          const delivered = yield* Queue.take(wakeups).pipe(
            Effect.timeout(SIGNAL_TIMEOUT)
          );

          assert.strictEqual(delivered.channel, WORKER_CHANNEL);
        })
      )
    );
  });
});
