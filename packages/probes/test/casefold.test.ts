/**
 * Probe 4 (Contracts 5.5): `casefold` is IMMUTABLE, an expression index on
 * the fold is used by folded equality, and a unique index on it makes keys
 * unique by key.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { KEY_COLLISIONS, runCasefoldProbe } from "../src/casefold.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

const ROWS = 20_000;

describe("probe-casefold", () => {
  it("tests collisions that need full case folding, not lower()", () => {
    assert.deepStrictEqual(
      KEY_COLLISIONS.map(([first]) => first),
      ["Straße", "ΣΑΣ", "ﬁle"]
    );
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "casefold is immutable, indexable, used by equality and unique by key",
      () =>
        Effect.gen(function* casefoldFacts() {
          const result = yield* Effect.scoped(runCasefoldProbe({ rows: ROWS }));

          assert.strictEqual(result.provolatile, "i");
          assert.include(result.planIndexes, "probe_casefold_key");
          assert.notInclude(result.planNodes, "Seq Scan");
          assert.strictEqual(result.boundMatches, result.boundLookups);
          assert.isAtLeast(result.idxScanDelta, result.boundLookups);
          assert.strictEqual(result.seqScanDelta, 0);

          for (const collision of result.collisions) {
            assert.strictEqual(
              collision.sqlState,
              "23505",
              `${collision.second} after ${collision.first}`
            );
            assert.strictEqual(
              collision.constraint,
              "probe_casefold_unique_key"
            );
          }

          const strasse = result.foldExamples.find(
            (example) => example.input === "Straße"
          );

          assert.strictEqual(strasse?.unicodeFast, "strasse");
        })
    );
  });
});
