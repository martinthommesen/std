/**
 * Probe 3c (Contracts 1.4 DDL table): with the inventory's locks taken
 * explicitly first, no DDL form takes a relation lock beyond them (other
 * than the relations it creates, indexes and TOAST tables of locked tables,
 * and system catalogs). This keeps the inventory complete as forms are
 * added: a form whose DDL locks something unlisted fails here.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  DDL_LOCK_INVENTORY,
  modeCovers,
  runLockInventoryProbe,
} from "../src/lock-inventory.ts";
import { probeDatabaseLayer } from "../src/probe-database.ts";

describe("probe-lock-inventory", () => {
  it("covers every form of the Contracts 1.4 DDL table that runs in the main transaction", () => {
    const forms = DDL_LOCK_INVENTORY.map((entry) => entry.form);

    for (const expected of [
      "Create child table with level FK",
      "Create class-change trigger",
      "Rewrite an ancestor's subtree check NOT VALID",
      "Add reference field: FK NOT VALID",
      "Drop a reference FK",
      "Purge reference field",
      "Rename table (referenced by a level FK)",
      "Set default",
      "Drop default",
      "Retire a required field (DROP NOT NULL)",
      "Make required: ADD CONSTRAINT NOT NULL NOT VALID",
      "Max length: ADD CONSTRAINT CHECK NOT VALID",
    ]) {
      assert.include(forms, expected);
    }
  });

  it("a mode covers another only if it conflicts with everything the other does", () => {
    assert.isTrue(modeCovers("AccessExclusiveLock", "ShareRowExclusiveLock"));
    assert.isTrue(modeCovers("ShareRowExclusiveLock", "AccessShareLock"));
    assert.isTrue(modeCovers("ShareRowExclusiveLock", "ShareLock"));
    assert.isFalse(modeCovers("ShareRowExclusiveLock", "AccessExclusiveLock"));
    assert.isFalse(modeCovers("ShareLock", "ShareUpdateExclusiveLock"));
  });

  layer(probeDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "no DDL form locks a relation beyond its explicit locks",
      () =>
        Effect.gen(function* inventoryIsComplete() {
          const results = yield* Effect.scoped(runLockInventoryProbe());

          assert.lengthOf(results, DDL_LOCK_INVENTORY.length);

          for (const result of results) {
            assert.deepStrictEqual(result.violations, [], result.form);
          }
        }),
      { timeout: 60_000 }
    );

    dbTest.effect(
      "the guard catches an incomplete inventory: purging a reference field also locks its target",
      () =>
        Effect.gen(function* guardCatchesMissingLock() {
          const purge = DDL_LOCK_INVENTORY.find(
            (entry) => entry.form === "Purge reference field"
          );

          assert.isDefined(purge);

          if (purge === undefined) {
            return;
          }

          const [result] = yield* Effect.scoped(
            runLockInventoryProbe([
              {
                form: "Purge reference field, target lock missing",
                step: {
                  ...purge.step,
                  locks: purge.step.locks.filter(
                    (lock) => lock.table !== "inv.target"
                  ),
                },
              },
            ])
          );

          assert.deepStrictEqual(result?.violations, [
            "inv.target AccessExclusiveLock",
          ]);
        }),
      { timeout: 60_000 }
    );
  });
});
