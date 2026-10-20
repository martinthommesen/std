/**
 * Probe 1 (Contracts 1.3, 1.4): a config commit that has to wait for a
 * 30 s request does not block requests for 30 s. Each attempt waits at most
 * 200 ms for `CONFIG_KEY` (requests queue behind it only that long), then
 * the commit retries and finally gives up with `SchemaLockTimeout` naming
 * the long request, which keeps running.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import {
  CONFIG_WAIT_MS,
  measureLongRequest,
  probeCoordinator,
  setupConfigPause,
} from "../src/config-pause.ts";
import type { ConfigPauseOptions } from "../src/config-pause.ts";
import {
  PROBE_APPLICATION_NAME,
  probeDatabaseLayer,
} from "../src/probe-database.ts";

const CLIENTS = 4;
const LONG_REQUEST_MS = 30_000;

/** Generous for a loaded CI machine; the bound itself is 200 ms per attempt. */
const PAUSE_LIMIT_MS = 1000;

const options: ConfigPauseOptions = {
  baselineMs: 0,
  batchMs: 2000,
  cancelLongRequest: true,
  clients: CLIENTS,
  items: 1000,
  longRequestMs: LONG_REQUEST_MS,
  retryDelays: [
    Duration.millis(100),
    Duration.millis(100),
    Duration.millis(100),
    Duration.millis(100),
  ],
  streamCommits: 0,
  streamGapMs: 0,
};

describe("probe-config-pause", () => {
  it("waits 200 ms for CONFIG_KEY per attempt", () => {
    assert.strictEqual(CONFIG_WAIT_MS, 200);
  });

  layer(probeDatabaseLayer({ maxConnections: CLIENTS + 6 }), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "a config commit blocked by a 30 s request times out per attempt and never pauses requests for long",
      () =>
        Effect.scoped(
          Effect.gen(function* configCommitDoesNotBlock() {
            yield* setupConfigPause(options.items);
            const coordinator = yield* probeCoordinator;
            const result = yield* measureLongRequest(options, coordinator);
            const { commit, window } = result;

            assert.strictEqual(commit.outcome, "SchemaLockTimeout");
            assert.strictEqual(commit.attempts, 5);
            assert.strictEqual(commit.attemptsWithLock, 0);
            assert.include(
              commit.holders,
              `${result.longRequestPid} (${PROBE_APPLICATION_NAME})`
            );
            assert.isBelow(commit.elapsedMs, LONG_REQUEST_MS / 2);
            assert.isTrue(
              result.observedBlockedByLongRequest,
              "the commit waited for the long request"
            );
            assert.isTrue(
              result.longRequestRunningAtEnd,
              "the long request was not disturbed"
            );

            assert.isAbove(window.requests, 0);
            assert.strictEqual(window.failed, 0);
            assert.isBelow(window.total.max, PAUSE_LIMIT_MS);
            assert.isBelow(window.longestGapMs, PAUSE_LIMIT_MS);
          })
        ),
      { timeout: 60_000 }
    );
  });
});
