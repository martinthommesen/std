/**
 * Probe 5 (Contracts 1.4, 6.5): `ADD COLUMN` with a constant default on a
 * populated table changes only the catalog. The 1,000,000-row size and the
 * strict 100 ms bound are the measurement script's (`pnpm probes`); CI uses
 * 100,000 rows and asserts under 1 s.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { ADD_COLUMN_CASES, runAddColumnProbe } from "../src/add-column.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

/**
 * Large enough to make a rewrite visible, small enough not to slow the
 * server's checkpoints for concurrent test files (dropping a test database
 * waits for one). The 1,000,000-row run is `pnpm probes`.
 */
const ROWS = 100_000;
const LOOSE_BOUND_MS = 1000;

describe("probe-add-column", () => {
  it("covers the boolean field, a nullable constant default and a volatile contrast case", () => {
    assert.deepStrictEqual(
      ADD_COLUMN_CASES.map((probeCase) => probeCase.catalogOnly),
      [true, true, false]
    );
    assert.include(ADD_COLUMN_CASES[0]?.column ?? "", "NOT NULL DEFAULT false");
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a constant default leaves relfilenode and seq_scan unchanged; a volatile one rewrites",
      () =>
        Effect.gen(function* addColumnFacts() {
          const result = yield* Effect.scoped(
            runAddColumnProbe({ rows: ROWS })
          );

          assert.lengthOf(result.cases, ADD_COLUMN_CASES.length);

          for (const measured of result.cases) {
            if (measured.expectedCatalogOnly) {
              assert.strictEqual(
                measured.relfilenodeAfter,
                measured.relfilenodeBefore,
                `${measured.label}: no rewrite`
              );
              assert.strictEqual(
                measured.seqScanAfter,
                measured.seqScanBefore,
                `${measured.label}: no scan`
              );
              assert.isBelow(measured.statementMs, LOOSE_BOUND_MS);
            } else {
              assert.notStrictEqual(
                measured.relfilenodeAfter,
                measured.relfilenodeBefore,
                `${measured.label}: the probe detects a rewrite`
              );
            }
          }
        }),
      { timeout: 60_000 }
    );
  });
});
