/**
 * Probe 3d (Contracts 1.4 step 2): waits on locks `LOCK TABLE` cannot take
 * in advance (indexes of locked tables, system catalogs) are not budgeted,
 * but each is capped by `lock_timeout` set to the remaining budget, so an
 * attempt ends within budget × (1 + internal waits). Sessions that lock an
 * index or a catalog directly are the only ones that cause such waits.
 * Phases follow `pg_blocking_pids()`; timing bounds are generous.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { DDL_LOCK_BUDGET_MS } from "../src/budgeted-ddl.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";
import { runUnbudgetedWaitProbe } from "../src/unbudgeted-waits.ts";
import type {
  UnbudgetedResult,
  UnbudgetedTarget,
} from "../src/unbudgeted-waits.ts";

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

/** Targets whose blockers both hold internal locks. */
type InternalTarget = Exclude<UnbudgetedTarget, "table-then-index">;

const TARGETS: readonly InternalTarget[] = ["index", "catalog"];

/**
 * The locks the DDL requested while it waited: ACCESS EXCLUSIVE on the
 * indexes it drops with the column, ROW EXCLUSIVE on the catalogs it writes
 * (which conflicts only with SHARE and stronger: direct catalog maintenance).
 */
const REQUESTED: Readonly<Record<InternalTarget, readonly string[]>> = {
  catalog: ["pg_class RowExclusiveLock", "pg_type RowExclusiveLock"],
  index: [
    "inv.child_owner_ix AccessExclusiveLock",
    "inv.child_owner_serial_ix AccessExclusiveLock",
  ],
};

/**
 * The documented worst case of one attempt, with slack.
 * @param result - A probe run.
 * @returns Budget × (1 + internal waits) plus slack, in milliseconds.
 */
const worstCase = (result: UnbudgetedResult): number =>
  DDL_LOCK_BUDGET_MS * (1 + result.internalBlockers) + SLACK_MS;

describe("probe-unbudgeted-waits", () => {
  it("contends two internal acquisitions per scenario", () => {
    assert.deepStrictEqual(TARGETS, ["index", "catalog"]);
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    for (const target of TARGETS) {
      dbTest.effect(
        `${target}: waits that do not time out run past the budget, within budget × (1 + waits)`,
        () =>
          Effect.scoped(
            Effect.gen(function* holdBelowTimeout() {
              const result = yield* runUnbudgetedWaitProbe({
                holdMs: HOLD_MS,
                release: "after-hold",
                retryDelays: FAST_RETRIES,
                target,
              });

              const [attempt] = result.attempts;

              assert.lengthOf(result.attempts, 1, "no wait timed out");
              assert.isTrue(attempt?.ok);

              for (const waited of result.observedWaitsMs) {
                assert.isAtLeast(waited, HOLD_MS);
              }

              assert.deepStrictEqual(result.requestedLocks, REQUESTED[target]);
              assert.isAbove(attempt?.heldMs ?? 0, DDL_LOCK_BUDGET_MS);
              assert.isAtMost(attempt?.heldMs ?? 0, worstCase(result));
            })
          ),
        { timeout: 60_000 }
      );

      dbTest.effect(
        `${target}: a wait held past the remaining budget times out within it, and the retry commits`,
        () =>
          Effect.scoped(
            Effect.gen(function* holdPastTimeout() {
              const result = yield* runUnbudgetedWaitProbe({
                holdMs: HOLD_MS,
                release: "after-timeout",
                retryDelays: FAST_RETRIES,
                target,
              });

              const [first] = result.attempts;

              assert.deepStrictEqual(
                result.attempts.map((attempt) => attempt.ok),
                [false, true]
              );
              assert.isAbove(result.observedWaitsMs[0] ?? 0, 0);
              assert.isAtMost(
                first?.heldMs ?? 0,
                DDL_LOCK_BUDGET_MS + SLACK_MS
              );
            })
          ),
        { timeout: 60_000 }
      );
    }

    dbTest.effect(
      "after an explicit lock spent part of the budget, an internal wait gets only the remainder",
      () =>
        Effect.scoped(
          Effect.gen(function* remainderOnly() {
            const result = yield* runUnbudgetedWaitProbe({
              holdMs: HOLD_MS,
              release: "after-timeout",
              retryDelays: FAST_RETRIES,
              target: "table-then-index",
            });

            const [tableWait = 0, indexWait = 0] = result.observedWaitsMs;
            const [first] = result.attempts;
            const remainder = DDL_LOCK_BUDGET_MS - HOLD_MS;

            assert.deepStrictEqual(result.requestedLocks, [
              "inv.child AccessExclusiveLock",
              "inv.child_owner_ix AccessExclusiveLock",
            ]);
            assert.isAtLeast(tableWait, HOLD_MS, "the explicit lock waited");
            // The internal wait timed out after about the remainder (0.8 s),
            // not after a fresh 2 s.
            assert.isAbove(indexWait, 0);
            assert.isAtMost(indexWait, remainder + SLACK_MS);
            assert.deepStrictEqual(
              result.attempts.map((attempt) => attempt.ok),
              [false, true]
            );
            // The attempt ended near the original 2 s deadline, not at
            // HOLD_MS + 2 s.
            assert.isAtMost(first?.heldMs ?? 0, DDL_LOCK_BUDGET_MS + SLACK_MS);
            assert.isBelow(first?.heldMs ?? 0, HOLD_MS + DDL_LOCK_BUDGET_MS);
          })
        ),
      { timeout: 60_000 }
    );
  });
});
