/**
 * Probe 3b (Contracts 1.4 step 2): one `CREATE TABLE` with two foreign keys
 * needs two locks. Under `lock_timeout = '2s'` alone each lock gets its own
 * 2 s, so one attempt holds `CONFIG_KEY` past the budget; with every lock
 * taken explicitly under the remaining budget, no attempt does. Phases are
 * ordered by `pg_blocking_pids()`; timing bounds are generous.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { DDL_LOCK_BUDGET_MS } from "../src/budgeted-ddl.ts";
import { MULTI_LOCK_STEP, runLockBudgetProbe } from "../src/lock-budget.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

/** Below the budget, with room for polling on a loaded machine. */
const HOLD_MS = 1200;

/** Round trips and polling on a loaded machine. */
const SLACK_MS = 500;

const FAST_RETRIES = [
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
];

describe("probe-lock-budget", () => {
  it("the statement needs SHARE ROW EXCLUSIVE on both referenced tables", () => {
    assert.deepStrictEqual(
      MULTI_LOCK_STEP.locks.map((lock) => lock.mode),
      ["SHARE ROW EXCLUSIVE", "SHARE ROW EXCLUSIVE"]
    );
    assert.strictEqual(DDL_LOCK_BUDGET_MS, 2000);
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "with per-statement lock_timeout one attempt waits for both locks, past the 2 s budget",
      () =>
        Effect.scoped(
          Effect.gen(function* perStatement() {
            const result = yield* runLockBudgetProbe({
              holdMs: HOLD_MS,
              mechanism: "per-statement",
              retryDelays: FAST_RETRIES,
            });

            const [attempt] = result.attempts;

            assert.lengthOf(result.attempts, 1, "no lock wait timed out");
            assert.isTrue(attempt?.ok);
            assert.isAtLeast(result.observedWaitsMs[0] ?? 0, HOLD_MS);
            assert.isAtLeast(result.observedWaitsMs[1] ?? 0, HOLD_MS);
            assert.isAbove(attempt?.heldMs ?? 0, DDL_LOCK_BUDGET_MS);
            assert.isAbove(result.requestMs, DDL_LOCK_BUDGET_MS);
            assert.isTrue(result.tableCreated);
          })
        ),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "with explicit locks under the remaining budget no attempt waits past it, and the retry commits",
      () =>
        Effect.scoped(
          Effect.gen(function* lockBudget() {
            const result = yield* runLockBudgetProbe({
              holdMs: HOLD_MS,
              mechanism: "lock-budget",
              retryDelays: FAST_RETRIES,
            });

            const [first] = result.attempts;

            assert.isAtLeast(result.attempts.length, 2);
            assert.isFalse(first?.ok, "the first attempt spent its budget");
            assert.isTrue(result.attempts.at(-1)?.ok);

            for (const attempt of result.attempts) {
              assert.isAtMost(attempt.heldMs, DDL_LOCK_BUDGET_MS + SLACK_MS);
            }

            assert.isAtMost(result.requestMs, DDL_LOCK_BUDGET_MS + SLACK_MS);
            assert.isTrue(result.tableCreated);
          })
        ),
      { timeout: 60_000 }
    );
  });
});
