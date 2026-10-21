/**
 * Probe 2 (Contracts 1.5): when the client of a concurrent index build is
 * killed (its process, not its backend), the backend keeps its session
 * lock until the build ends and leaves a valid or a detectably invalid
 * index. With a nonzero `client_connection_check_interval` the backend
 * notices the lost client and gives up early.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { runKilledBuildScenario } from "../src/killed-index-build.ts";
import type { KilledBuildScenario } from "../src/killed-index-build.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

const HOLD_MS = 1000;

const base: KilledBuildScenario = {
  busy: "writer",
  checkInterval: "0",
  duplicate: false,
  holdAfterKillMs: HOLD_MS,
  label: "",
  rows: 10_000,
  unique: false,
};

describe("probe-killed-index-build", () => {
  it("kills the client while the build waits for an open writer", () => {
    assert.strictEqual(base.busy, "writer");
    assert.strictEqual(base.checkInterval, "0");
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "with client_connection_check_interval = 0 the build outlives its client, keeps SCHEMA_KEY, and ends valid",
      () =>
        Effect.gen(function* buildOutlivesClient() {
          const result = yield* Effect.scoped(
            runKilledBuildScenario({ ...base, label: "valid" })
          );

          assert.strictEqual(result.effectiveCheckInterval, "0");
          assert.isTrue(result.backendAliveAfterKill);
          assert.isTrue(result.lockHeldAfterKill);
          assert.isTrue(result.tryLockRefusedAfterKill);
          assert.isAtLeast(result.backendExitAfterKillMs, HOLD_MS);
          assert.strictEqual(result.indexState, "valid");
          assert.isTrue(result.lockFreeAfterEnd);
        }),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "a unique build that meets a duplicate after its client died leaves an invalid index and frees SCHEMA_KEY",
      () =>
        Effect.gen(function* buildFailsAfterKill() {
          const result = yield* Effect.scoped(
            runKilledBuildScenario({
              ...base,
              duplicate: true,
              label: "invalid",
              unique: true,
            })
          );

          assert.isTrue(result.backendAliveAfterKill);
          assert.isTrue(result.lockHeldAfterKill);
          assert.strictEqual(result.indexState, "invalid");
          assert.isTrue(result.lockFreeAfterEnd);
        }),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "with a nonzero client_connection_check_interval the backend gives up once the client is gone",
      () =>
        Effect.gen(function* buildCancelledByCheck() {
          const result = yield* Effect.scoped(
            runKilledBuildScenario({
              ...base,
              checkInterval: "100ms",
              label: "checked",
            })
          );

          assert.strictEqual(result.effectiveCheckInterval, "100ms");
          assert.isFalse(result.backendAliveAfterKill);
          assert.isBelow(result.backendExitAfterKillMs, HOLD_MS);
          assert.strictEqual(result.indexState, "invalid");
          assert.isTrue(result.lockFreeAfterEnd);
        }),
      { timeout: 60_000 }
    );
  });
});
