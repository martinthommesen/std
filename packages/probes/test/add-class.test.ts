/**
 * Probe 3 (Contracts 2.4): adding a class to a populated hierarchy widens
 * each ancestor's subtree check `NOT VALID` and creates the child with its
 * level FK, without scanning or rewriting any ancestor; a long reader makes
 * the first attempt hit `lock_timeout`, and the retry succeeds. Readers that
 * release the root and the parent at different times show `lock_timeout`
 * applies to each lock: one attempt holds `CONFIG_KEY` past 2 s.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import {
  ancestorsOf,
  BASE_CLASSES,
  NEW_CLASS,
  runAddClassProbe,
} from "../src/add-class.ts";
import type { AddClassProbeResult } from "../src/add-class.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";
import { STAGGERED_READERS } from "../src/settings.ts";

const ROWS = 30_000;

const FAST_RETRIES = [
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
  Duration.millis(50),
];

const READER_HOLD_MS = 2500;
const DDL_LOCK_TIMEOUT_MS = 2000;

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

  assert.isTrue(result.newRecordInserted);
  assert.strictEqual(result.foreignClassRefused, "23514");
};

describe("probe-add-class", () => {
  it("adds a grandchild, so the root and the parent are altered root first", () => {
    assert.deepStrictEqual(
      ancestorsOf([...BASE_CLASSES, NEW_CLASS], NEW_CLASS).map(
        (ancestor) => ancestor.table
      ),
      ["asset", "laptop"]
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "adding a class scans and rewrites no ancestor and takes ACCESS EXCLUSIVE on each briefly",
      () =>
        Effect.gen(function* addClassFacts() {
          const result = yield* Effect.scoped(runAddClassProbe({ rows: ROWS }));

          assertNoScanNoRewrite(result, false);
          assert.strictEqual(result.attempts, 1);

          for (const table of ["probe.asset", "probe.laptop"]) {
            assert.deepInclude(result.locks, {
              mode: "AccessExclusiveLock",
              object: table,
            });
          }

          assert.isBelow(result.commitMs, DDL_LOCK_TIMEOUT_MS);
        }),
      { timeout: 60_000 }
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a long reader makes the first attempt time out after 2 s; the retry succeeds and nothing was half applied",
      () =>
        Effect.gen(function* addClassUnderReader() {
          const result = yield* Effect.scoped(
            runAddClassProbe({
              readers: [
                { holdMs: READER_HOLD_MS, tables: ["asset", "laptop"] },
              ],
              retryDelays: FAST_RETRIES,
              rows: ROWS,
            })
          );

          // The long reader and the timed reads scan the root themselves.
          assertNoScanNoRewrite(result, true);
          assert.strictEqual(result.attempts, 2);
          assert.isAtLeast(result.commitMs, READER_HOLD_MS);
          // The plain read queued behind the waiting ALTER; the STD request
          // waited on CONFIG_KEY. Both waited about one lock_timeout, not
          // for the reader.
          assert.isAbove(result.waitingReads?.plainReadMs ?? 0, 1000);
          assert.isBelow(
            result.waitingReads?.plainReadMs ?? Number.POSITIVE_INFINITY,
            READER_HOLD_MS
          );
          assert.isBelow(
            result.waitingReads?.requestMs ?? Number.POSITIVE_INFINITY,
            READER_HOLD_MS
          );
        }),
      { timeout: 60_000 }
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "lock_timeout applies to each lock: staggered readers keep one attempt, and CONFIG_KEY, past 2 s",
      () =>
        Effect.gen(function* staggeredReaders() {
          const result = yield* Effect.scoped(
            runAddClassProbe({ readers: STAGGERED_READERS, rows: ROWS })
          );

          const [, parent] = STAGGERED_READERS;

          assert.strictEqual(result.attempts, 1, "no lock wait timed out");
          assert.isAbove(result.commitMs, DDL_LOCK_TIMEOUT_MS + 500);
          assert.isAtLeast(result.commitMs, parent.holdMs - 500);
          // The STD request waited for CONFIG_KEY for the whole attempt.
          assert.isAbove(
            result.waitingReads?.requestMs ?? 0,
            DDL_LOCK_TIMEOUT_MS + 200
          );
        }),
      { timeout: 60_000 }
    );
  });
});
