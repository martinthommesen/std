import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  allowed,
  refused,
} from "../../../tooling/canaries/migration-phases/fixtures.ts";
import { migrationPhaseProblems } from "../../../tooling/lib/migration-phases.ts";
import { runTool } from "../../../tooling/test/run-tools.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";

const migration = (statements: readonly string[], phase = "expand") => ({
  id: 17,
  kind: "tx",
  name: "fixture",
  phase,
  statements,
});

describe("migration-phases", () => {
  it("registers the phase check for the real migration list", () => {
    assert.isAbove(PLATFORM_MIGRATIONS.length, 0);
    assert.deepStrictEqual(migrationPhaseProblems(PLATFORM_MIGRATIONS), []);
  });
  it.effect(
    "checks every real migration through check:tooling's executable",
    () =>
      Effect.gen(function* registeredMigrations() {
        assert.deepStrictEqual(migrationPhaseProblems(PLATFORM_MIGRATIONS), []);

        const result = yield* Effect.promise(
          async () => await runTool("check-migration-phases.ts")
        );

        assert.strictEqual(result.code, 0, result.output);
      })
  );

  it.effect(
    "accepts additive SQL fixtures including literals and comments",
    () =>
      Effect.sync(() => {
        for (const sql of allowed) {
          assert.deepStrictEqual(
            migrationPhaseProblems([migration([sql])]),
            [],
            sql
          );
        }
      })
  );

  it.effect(
    "refuses destructive, rewriting and unrecognized expand SQL fixtures",
    () =>
      Effect.sync(() => {
        for (const sql of refused) {
          assert.isAbove(
            migrationPhaseProblems([migration([sql])]).length,
            0,
            sql
          );
        }
      })
  );

  it.effect(
    "refuses missing and unknown phases, including data migrations",
    () =>
      Effect.sync(() => {
        for (const kind of ["tx", "data", "concurrent_index"]) {
          assert.isAbove(
            migrationPhaseProblems([{ id: 17, kind, name: "missing" }]).length,
            0
          );
          assert.isAbove(
            migrationPhaseProblems([
              { id: 17, kind, name: "unknown", phase: "finalize" },
            ]).length,
            0
          );
        }
      })
  );

  it.effect(
    "allows contract SQL and constraints on tables created in the same migration",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          migrationPhaseProblems([migration(refused, "contract")]),
          []
        );
        assert.deepStrictEqual(
          migrationPhaseProblems([
            migration([
              "CREATE TABLE core.new_table (id int)",
              "ALTER TABLE core.new_table ADD CONSTRAINT c UNIQUE (id)",
            ]),
          ]),
          []
        );
      })
  );

  it.effect("requires a new function name across migration history", () =>
    Effect.sync(() => {
      const original =
        "CREATE FUNCTION core.fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$";

      const changed =
        "CREATE FUNCTION core.fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$";

      assert.isAbove(
        migrationPhaseProblems([
          migration([original]),
          { ...migration([changed]), id: 18 },
        ]).length,
        0
      );
    })
  );

  it("matches quoted function names and contract-phase function definitions", () => {
    assert.isAbove(
      migrationPhaseProblems([
        migration(
          [
            'CREATE OR REPLACE FUNCTION core."fn"() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
          ],
          "contract"
        ),
        {
          ...migration([
            "CREATE FUNCTION core.fn(x int) RETURNS int LANGUAGE sql AS $$ SELECT x $$",
          ]),
          id: 18,
        },
      ]).length,
      0
    );
  });
});
