/**
 * `std upgrade` (Contracts 8.5) and the refusals of 8.4: `--plan` changes
 * nothing and the real run applies exactly that plan, refusing when the
 * database changed in between; downgrades, type changes, name clashes with
 * local definitions and removed roles that local rules still name are
 * refused at plan time with nothing applied; the upgrade refuses while a
 * server is connected and on a non-UTF8 database; a rerun after a failure
 * continues from the last committed change set.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { Effect, Fiber } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { planLines } from "../src/cli/format.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { readInstalledState } from "../src/config/installed-state.ts";
import { SCHEMA_LIFECYCLE } from "../src/config/lifecycle.ts";
import {
  applySetLoad,
  planSetLoad,
  requiredOwners,
} from "../src/config/load-set.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { SetRefused } from "../src/config/set-refused.ts";
import { planUpgrade, runUpgrade } from "../src/config/upgrade.ts";
import {
  ADMIN,
  catalogFingerprint,
  configFingerprint,
  FIXTURE,
  FX,
  insertAdmin,
  fieldLabel,
  variantOf,
  writeSetDirectory,
} from "./config-support.ts";
import {
  addField,
  change,
  createRole,
  currentRevision,
  FAST_RETRIES,
  insertRecords,
  insertRecordsSql,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { errorOf, waitUntil } from "./support.ts";

/** A second app set of the rerun test. */
const OTHER_SET = "5c8ff7e6-8faa-4e64-a6e9-dad8efdbb09a";

const OTHER_NAMESPACE = "0dcbd1b3-5d75-4b07-a5e6-17dc5fedec58";

/** A unique index a fixture variant adds on `fx.item.x`. */
const UNIQUE_X = "d136ff65-5a71-4e1d-a886-4f6aaeabd746";

/** A field a later fixture version adds. */
const EXTRA_FIELD = "d7a38eb2-3d98-4e4f-97e6-0e15c87f2329";

/** Everything `--plan` must leave unchanged. */
const databaseState = Effect.gen(function* databaseState() {
  return {
    catalog: yield* catalogFingerprint,
    config: yield* configFingerprint,
    revision: yield* currentRevision,
  };
});

const installedVersion = (name: string) =>
  values(
    `SELECT set_version::text AS value FROM core."config_set" WHERE name = $1`,
    [name]
  ).pipe(Effect.map(([version]) => version ?? "none"));

const localRule = (roleId: string, description: string): Operation => ({
  definition: {
    actions: ["read"],
    active: true,
    classId: FX.item,
    condition: null,
    description,
    effect: "allow",
    id: randomUUID(),
    kind: "accessRule",
    owner: { layer: "local" },
    protected: false,
    roleIds: [roleId],
    target: { kind: "records" },
  },
  op: "createAccessRule",
});

const idByName = (table: string, name: string) =>
  values(`SELECT id::text AS value FROM core."${table}" WHERE name = $1`, [
    name,
  ]).pipe(Effect.map(([id]) => id ?? ""));

/**
 * The refusals of a failed upgrade, as code and details JSON.
 *
 * @param effect - The upgrade.
 * @returns The refusals; empty when it did not fail with `SetRefused`.
 */
const refusalsOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      const failure = errorOf(exit);

      return failure instanceof SetRefused
        ? failure.refusals.map((entry) => [
            entry.code,
            JSON.stringify(entry.details),
          ])
        : [];
    })
  );

describe("upgrade", () => {
  it("prints refusals and an empty security section in the plan's text form", () => {
    const lines = planLines({
      basis: { changeSetId: null, revision: null },
      hash: "h",
      migrations: [],
      refusals: [],
      resume: [],
      security: [],
      sets: [],
      stdVersion: "0.0.0",
      warnings: ["servers"],
    });

    assert.deepStrictEqual(lines.slice(-4), [
      "Security changes:",
      "  none",
      "Warning: servers",
      "Result: the upgrade can run",
    ]);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "--plan changes nothing; the real run applies the plan and refuses when the database changed since",
      () =>
        Effect.gen(function* planThenRun() {
          yield* runUpgrade({ sets: [FIXTURE.v1] });
          yield* insertAdmin;

          const before = yield* databaseState;
          const plan = yield* planUpgrade({ sets: [FIXTURE.v2] });

          assert.deepStrictEqual(yield* databaseState, before);
          assert.lengthOf(plan.hash, 64);

          const [version] = yield* values(
            "SELECT version::text AS value FROM core.field WHERE id = $1::uuid",
            [FX.x]
          );

          yield* editDefinition({
            actorId: ADMIN,
            changes: { label: "X local" },
            id: FX.x,
            version: Number(version),
          });

          const stale = errorOf(
            yield* Effect.exit(
              runUpgrade({ expectedPlanHash: plan.hash, sets: [FIXTURE.v2] })
            )
          );

          assert.strictEqual(stale?._tag, "UpgradePlanStale");
          assert.strictEqual(yield* installedVersion("fx"), "1");
          assert.strictEqual(
            yield* fieldLabel(FX.z),
            "Z v1",
            "nothing applied"
          );

          const replanned = yield* planUpgrade({ sets: [FIXTURE.v2] });

          const report = yield* runUpgrade({
            expectedPlanHash: replanned.hash,
            sets: [FIXTURE.v2],
          });

          assert.deepStrictEqual(report.plan, replanned);
          assert.strictEqual(yield* installedVersion("fx"), "2");
          assert.strictEqual(yield* fieldLabel(FX.z), "Z v2");
        })
    );

    dbTest.effect(
      "a set planned at one state stops in its main transaction when another commit came first",
      () =>
        Effect.gen(function* staleState() {
          const installed = yield* readInstalledState;
          const files = yield* readSetDirectory(FIXTURE.v3);

          const planned = yield* planSetLoad(files, installed, {
            lifecycle: SCHEMA_LIFECYCLE,
            required: requiredOwners(installed.layers),
          });

          yield* change([createRole("meanwhile")]);

          const failure = errorOf(yield* Effect.exit(applySetLoad(planned)));

          assert.strictEqual(failure?._tag, "ConfigStateChanged");
          assert.strictEqual(yield* installedVersion("fx"), "2");
        })
    );

    dbTest.effect(
      "a downgrade and a type change are refused at plan time and change nothing",
      () =>
        Effect.scoped(
          Effect.gen(function* refusedAtPlan() {
            const before = yield* databaseState;

            assert.deepStrictEqual(
              (yield* refusalsOf(runUpgrade({ sets: [FIXTURE.v1] }))).map(
                ([code]) => code
              ),
              ["downgrade"]
            );

            const retyped = variantOf(yield* readSetDirectory(FIXTURE.v2), {
              types: { z: "longText" },
              version: 3,
            });

            const directory = yield* writeSetDirectory(retyped);
            const plan = yield* planUpgrade({ sets: [directory] });

            assert.deepStrictEqual(
              plan.refusals.map((entry) => [entry.code, entry.definitionId]),
              [["typeChanged", FX.z]]
            );
            assert.deepStrictEqual(
              (yield* refusalsOf(runUpgrade({ sets: [directory] }))).map(
                ([code]) => code
              ),
              ["typeChanged"]
            );
            assert.deepStrictEqual(yield* databaseState, before);
          })
        )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a name clash with a local definition is refused at plan time naming it; after a rename the rerun succeeds",
      () =>
        Effect.scoped(
          Effect.gen(function* nameClash() {
            yield* runUpgrade({ sets: [FIXTURE.v1] });
            yield* insertAdmin;
            yield* insertAdmin;
            yield* change([createRole("approver")]);

            const localRole = yield* idByName("role", "approver");

            yield* change([
              localRule(localRole, "Local approvers read items."),
            ]);

            const before = yield* databaseState;

            const refusals = yield* refusalsOf(
              runUpgrade({ sets: [FIXTURE.v2] })
            );

            assert.deepStrictEqual(
              refusals.map(([code]) => code),
              ["nameClash"]
            );
            assert.include(refusals[0]?.[1] ?? "", localRole);
            assert.deepStrictEqual(yield* databaseState, before);

            const [version] = yield* values(
              "SELECT version::text AS value FROM core.role WHERE id = $1::uuid",
              [localRole]
            );

            yield* editDefinition({
              actorId: ADMIN,
              changes: { name: "local_approver" },
              id: localRole,
              version: Number(version),
            });

            yield* runUpgrade({ sets: [FIXTURE.v2] });

            assert.strictEqual(yield* installedVersion("fx"), "2");
            assert.strictEqual(
              yield* idByName("role", "approver"),
              FX.approver
            );
            assert.strictEqual(
              yield* idByName("role", "local_approver"),
              localRole
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT role_ids #>> '{0}' AS value FROM core.access_rule WHERE description = 'Local approvers read items.'`
              ),
              [localRole],
              "the local rule still names the local role"
            );

            yield* change([addField(FX.item, "foo", { kind: "text" }).op]);

            const withFoo = variantOf(yield* readSetDirectory(FIXTURE.v2), {
              addFields: [{ id: FX.foo, name: "foo", type: "text" }],
              version: 3,
            });

            const plan = yield* planUpgrade({
              sets: [yield* writeSetDirectory(withFoo)],
            });

            assert.deepStrictEqual(
              plan.refusals.map((entry) => [
                entry.code,
                entry.details.localName,
              ]),
              [["nameClash", "fx.item.foo"]]
            );
          })
        )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "removed upstream: rules deactivated; a role a local access rule names refuses the set",
      () =>
        Effect.scoped(
          Effect.gen(function* removedUpstream() {
            yield* runUpgrade({ sets: [FIXTURE.v2] });
            yield* insertAdmin;
            yield* change([localRule(FX.approver, "Local rule on approvers.")]);

            const v2 = yield* readSetDirectory(FIXTURE.v2);

            const withoutApprover = variantOf(v2, {
              dropRoles: ["approver"],
              version: 3,
            });

            const before = yield* databaseState;

            const refused = yield* planUpgrade({
              sets: [yield* writeSetDirectory(withoutApprover)],
            });

            assert.deepStrictEqual(
              refused.refusals.map((entry) => [entry.code, entry.definitionId]),
              [["roleInUse", FX.approver]]
            );
            assert.include(
              refused.refusals[0]?.message ?? "",
              "Local rule on approvers."
            );
            assert.deepStrictEqual(yield* databaseState, before);

            const withoutRule = variantOf(v2, {
              dropRules: [FX.ruleRecords],
              version: 3,
            });

            const report = yield* runUpgrade({
              sets: [yield* writeSetDirectory(withoutRule)],
            });

            assert.deepStrictEqual(
              report.plan.security.map((entry) => [entry.id, entry.change]),
              [[FX.ruleRecords, "deactivated"]]
            );
            assert.deepStrictEqual(
              yield* values(
                "SELECT active::text AS value FROM core.access_rule WHERE id = $1::uuid",
                [FX.ruleRecords]
              ),
              ["false"]
            );
          })
        )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "std upgrade refuses while a std-server session is connected; --plan only warns",
      () =>
        Effect.scoped(
          Effect.gen(function* serversConnected() {
            const database = yield* TestDatabase;
            const server = yield* database.session("std-server");
            const refused = errorOf(yield* Effect.exit(runUpgrade()));

            assert.strictEqual(refused?._tag, "UpgradeRefused");
            assert.include(refused?.message ?? "", String(server.processId));

            const plan = yield* planUpgrade();

            assert.include(plan.warnings.join(" "), "std-server sessions");
          })
        )
    );

    dbTest.effect(
      "a rerun after a failed set continues from the last committed change set",
      () =>
        Effect.scoped(
          Effect.gen(function* rerunAfterFailure() {
            yield* runUpgrade({ sets: [FIXTURE.v1] });
            yield* insertAdmin;
            yield* insertAdmin;

            const v1 = yield* readSetDirectory(FIXTURE.v1);

            const other = variantOf(v1, {
              replace: {
                accessRules: [],
                namespaces: [{ id: OTHER_NAMESPACE, name: "other" }],
                roles: [],
                set: {
                  id: OTHER_SET,
                  layer: "app",
                  name: "other",
                  requires: ["core"],
                  version: 1,
                },
                tables: [],
              },
              version: 1,
            });

            const grown = variantOf(v1, {
              addFields: [{ id: EXTRA_FIELD, name: "extra", type: "text" }],
              version: 2,
            });

            const sets = [
              yield* writeSetDirectory(other),
              yield* writeSetDirectory(grown),
            ];

            const database = yield* TestDatabase;
            const reader = yield* database.session("long-reader");

            yield* reader.query("BEGIN");
            yield* reader.query("SELECT count(*) FROM fx.item");

            const failure = errorOf(
              yield* Effect.exit(runUpgrade({ ...FAST_RETRIES, sets }))
            );

            assert.strictEqual(failure?._tag, "SchemaLockTimeout");
            assert.strictEqual(yield* installedVersion("other"), "1");
            assert.strictEqual(yield* installedVersion("fx"), "1");

            yield* reader.query("COMMIT");

            const rerun = yield* runUpgrade({ ...FAST_RETRIES, sets });

            assert.deepStrictEqual(
              rerun.sets.map((set) => [set.name, set.result.state]),
              [
                ["core", "unchanged"],
                ["other", "unchanged"],
                ["fx", "completed"],
              ]
            );
            assert.strictEqual(yield* installedVersion("fx"), "2");
          })
        )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a set whose index build fails stops the upgrade, and the rerun refuses until the change set is resolved",
      () =>
        Effect.scoped(
          Effect.gen(function* failedFollowUp() {
            yield* runUpgrade({ sets: [FIXTURE.v1] });
            yield* insertRecords(['"fx"."item"'], FX.item, 3, {
              x: "'v' || g",
            });

            const unique = yield* writeSetDirectory(
              variantOf(yield* readSetDirectory(FIXTURE.v1), {
                addIndexes: [{ fields: ["x"], id: UNIQUE_X, unique: true }],
                version: 2,
              })
            );

            const database = yield* TestDatabase;
            const writer = yield* database.session("late-writer");

            yield* writer.query("BEGIN");
            yield* writer.query(
              insertRecordsSql(['"fx"."item"'], FX.item, 1, { x: "'v1'" })
            );

            const upgrade = yield* Effect.forkChild(
              Effect.exit(runUpgrade({ sets: [unique] }))
            );

            yield* waitUntil(
              values(
                `SELECT count(*)::text AS value FROM pg_stat_progress_create_index
                 WHERE datid = (SELECT oid FROM pg_database WHERE datname = current_database())`
              ).pipe(Effect.map(([count]) => count !== "0"))
            );
            yield* writer.query("COMMIT");

            const failed = errorOf(yield* Fiber.join(upgrade));

            assert.strictEqual(failed?._tag, "UpgradeIncomplete");
            assert.include(failed?.message ?? "", "std schema resume");

            const [changeSet = ""] = yield* values(
              `SELECT id::text AS value FROM core."schema_change" WHERE state = 'needs_attention'`
            );

            assert.include(failed?.message ?? "", changeSet);

            const rerun = yield* refusalsOf(runUpgrade({ sets: [unique] }));

            assert.deepStrictEqual(
              rerun.map(([code]) => code),
              ["unfinishedChangeSet"]
            );
          })
        )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a set requiring itself, or a cycle through installed sets, is refused",
      () =>
        Effect.scoped(
          Effect.gen(function* cycles() {
            const v1 = yield* readSetDirectory(FIXTURE.v1);

            const header = {
              id: FX.set,
              layer: "app",
              name: "fx",
              version: 2,
            } as const;

            const selfRequiring = variantOf(v1, {
              replace: { set: { ...header, requires: ["core", "fx"] } },
              version: 2,
            });

            assert.deepStrictEqual(
              (yield* planUpgrade({
                sets: [yield* writeSetDirectory(selfRequiring)],
              })).refusals.map((entry) => [entry.code, entry.set]),
              [["setCycle", "fx"]]
            );

            const other = variantOf(v1, {
              replace: {
                accessRules: [],
                namespaces: [{ id: OTHER_NAMESPACE, name: "other" }],
                roles: [],
                set: {
                  id: OTHER_SET,
                  layer: "app",
                  name: "other",
                  requires: ["core", "fx"],
                  version: 1,
                },
                tables: [],
              },
              version: 1,
            });

            yield* runUpgrade({
              sets: [FIXTURE.v1, yield* writeSetDirectory(other)],
            });

            const requiringOther = variantOf(v1, {
              replace: { set: { ...header, requires: ["core", "other"] } },
              version: 2,
            });

            assert.deepStrictEqual(
              (yield* planUpgrade({
                sets: [yield* writeSetDirectory(requiringOther)],
              })).refusals.map((entry) => [entry.code, entry.set]),
              [
                ["setCycle", "fx"],
                ["setCycle", "other"],
              ]
            );
          })
        )
    );
  });

  layer(schemaTestLayer({ encoding: "SQL_ASCII" }), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect("std upgrade refuses a database that is not UTF8", () =>
      Effect.gen(function* notUtf8() {
        const refused = errorOf(yield* Effect.exit(runUpgrade()));

        assert.strictEqual(refused?._tag, "UpgradeRefused");
        assert.include(refused?.message ?? "", "SQL_ASCII");
      })
    );
  });
});
