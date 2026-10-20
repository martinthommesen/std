/**
 * Probe 3 (Contracts 1.4, 2.4): adding a class to a populated hierarchy
 * widens each ancestor's subtree check `NOT VALID` and creates the child
 * with its level FK, without scanning or rewriting any ancestor. Blocking
 * scenarios are ordered by `pg_blocking_pids()` and `pg_locks`, not sleeps;
 * the assertions are about who blocked whom and what was rolled back, with
 * generous timing bounds.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import {
  addClassSteps,
  ancestorsOf,
  BASE_CLASSES,
  NEW_CLASS,
  runAddClassProbe,
} from "../src/add-class.ts";
import type { AddClassProbeResult } from "../src/add-class.ts";
import { DDL_LOCK_BUDGET_MS } from "../src/budgeted-ddl.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

const ROWS = 30_000;

const FAST_RETRIES = [
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
];

/** Below the 2 s budget, with room for polling on a loaded machine. */
const HOLD_MS = 1200;

/** Round trips and polling on a loaded machine. */
const SLACK_MS = 500;

const assertNoScanNoRewrite = (
  result: AddClassProbeResult,
  othersScan: boolean
) => {
  assert.deepStrictEqual(
    result.ancestors.map((ancestor) => ancestor.table),
    ["asset", "laptop"]
  );

  for (const ancestor of result.ancestors) {
    assert.strictEqual(
      ancestor.after.relfilenode,
      ancestor.before.relfilenode,
      `${ancestor.table}: no rewrite`
    );
    assert.strictEqual(
      ancestor.transactionSeqScans,
      0,
      `${ancestor.table}: the change set scans nothing`
    );

    if (!othersScan) {
      assert.strictEqual(
        ancestor.after.seqScan,
        ancestor.before.seqScan,
        `${ancestor.table}: no scan at all`
      );
    }

    assert.isFalse(ancestor.checkValidated, `${ancestor.table}: NOT VALID`);
  }

  assert.strictEqual(result.revisionDelta, 1, "exactly one revision");
  assert.isTrue(result.newRecordInserted);
  assert.strictEqual(result.foreignClassRefused, "23514");
};

describe("probe-add-class", () => {
  it("adds a grandchild: root and parent are altered root first, the parent is locked for the level FK", () => {
    assert.deepStrictEqual(
      ancestorsOf([...BASE_CLASSES, NEW_CLASS], NEW_CLASS).map(
        (ancestor) => ancestor.table
      ),
      ["asset", "laptop"]
    );
    assert.deepStrictEqual(
      addClassSteps().flatMap((step) =>
        step.locks.map((lock) => `${lock.table} ${lock.mode}`)
      ),
      [
        "probe.asset ACCESS EXCLUSIVE",
        "probe.laptop ACCESS EXCLUSIVE",
        "probe.laptop SHARE ROW EXCLUSIVE",
      ]
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "adding a class scans and rewrites no ancestor and takes ACCESS EXCLUSIVE on each briefly",
      () =>
        Effect.gen(function* addClassFacts() {
          const result = yield* Effect.scoped(runAddClassProbe({ rows: ROWS }));

          assertNoScanNoRewrite(result, false);
          assert.lengthOf(result.attempts, 1);

          for (const table of ["probe.asset", "probe.laptop"]) {
            assert.deepInclude(result.locks, {
              mode: "AccessExclusiveLock",
              object: table,
            });
          }

          assert.deepInclude(result.locks, {
            mode: "ShareRowExclusiveLock",
            object: "probe.laptop",
          });
          assert.isBelow(result.commitMs, DDL_LOCK_BUDGET_MS);
        }),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "a reader past lock_timeout: the attempt rolls back, queued reads finish before the reader lets go, the retry commits",
      () =>
        Effect.gen(function* readerPastTimeout() {
          const result = yield* Effect.scoped(
            runAddClassProbe({
              blocking: { kind: "reader-past-timeout" },
              retryDelays: FAST_RETRIES,
              rows: ROWS,
            })
          );

          // The reader and the queued reads scan the root themselves.
          assertNoScanNoRewrite(result, true);
          assert.deepStrictEqual(
            result.attempts.map((attempt) => attempt.ok),
            [false, true]
          );

          const [first] = result.attempts;

          assert.isAtLeast(first?.heldMs ?? 0, DDL_LOCK_BUDGET_MS - SLACK_MS);
          assert.isAtMost(first?.heldMs ?? 0, DDL_LOCK_BUDGET_MS + SLACK_MS);
          assert.isTrue(result.queue?.plainReadQueuedBehindDdl);
          assert.isTrue(result.queue?.requestQueuedBehindCommit);
          assert.isTrue(result.queue?.readsDoneBeforeRelease);
          assert.isTrue(result.queue?.revisionUnchangedAfterFailedAttempt);
        }),
      { timeout: 60_000 }
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "per-statement lock_timeout: staggered readers keep one attempt, and CONFIG_KEY, past the 2 s budget",
      () =>
        Effect.gen(function* staggeredPerStatement() {
          const result = yield* Effect.scoped(
            runAddClassProbe({
              blocking: { holdMs: HOLD_MS, kind: "staggered" },
              mechanism: "per-statement",
              retryDelays: FAST_RETRIES,
              rows: ROWS,
            })
          );

          const [attempt] = result.attempts;

          assertNoScanNoRewrite(result, true);
          assert.lengthOf(result.attempts, 1, "no lock wait timed out");

          for (const waited of result.staggered?.observedWaitsMs ?? []) {
            assert.isAtLeast(waited, HOLD_MS);
          }

          assert.isAbove(attempt?.heldMs ?? 0, DDL_LOCK_BUDGET_MS);
          assert.isAbove(
            result.staggered?.requestMs ?? 0,
            DDL_LOCK_BUDGET_MS,
            "an STD request waited past the budget"
          );
        }),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "lock budget: the same readers stop the attempt at the budget; the retry commits",
      () =>
        Effect.gen(function* staggeredBudget() {
          const result = yield* Effect.scoped(
            runAddClassProbe({
              blocking: { holdMs: HOLD_MS, kind: "staggered" },
              mechanism: "lock-budget",
              retryDelays: FAST_RETRIES,
              rows: ROWS,
            })
          );

          assertNoScanNoRewrite(result, true);
          assert.isAtLeast(result.attempts.length, 2);
          assert.isFalse(result.attempts[0]?.ok);
          assert.isTrue(result.attempts.at(-1)?.ok);

          for (const attempt of result.attempts) {
            assert.isAtMost(attempt.heldMs, DDL_LOCK_BUDGET_MS + SLACK_MS);
          }

          assert.isAtMost(
            result.staggered?.requestMs ?? Number.POSITIVE_INFINITY,
            DDL_LOCK_BUDGET_MS + SLACK_MS
          );
        }),
      { timeout: 60_000 }
    );
  });
});
