import { assert, describe, it, layer } from "@effect/vitest";
/**
 * The Step 1 gate fixture (Contracts 8.4 acceptance tests, plan Step 1):
 * the upgrade fixture set upgraded v1 to v2 with local label overrides and
 * shipped roles. Z shows v2; X keeps its local label with one conflict; W's
 * override is gone with a `converged` entry; the access rule naming the
 * renamed role keeps working; the access-rule and role changes appear under
 * security changes; rerunning changes nothing, the revision included; a
 * `keep_local` resolution survives a v3 that does not change X; `doctor`
 * exits 0 throughout.
 */
import { Effect } from "effect";

import {
  editDefinition,
  resolveConflict,
} from "../src/config/config-service.ts";
import { planUpgrade, runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { exitCodeOf, finding } from "../src/doctor/finding.ts";
import type { Finding } from "../src/doctor/finding.ts";
import {
  ADMIN,
  conflictsOf,
  FIXTURE,
  FX,
  fieldLabel,
  latestRevisionLabel,
  openConflictIds,
  overridesOf,
} from "./config-support.ts";
import { currentRevision, schemaTestLayer, values } from "./schema-support.ts";

const roleName = (id: string) =>
  values("SELECT name AS value FROM core.role WHERE id = $1::uuid", [id]);

const ruleRolesAndActions = (id: string) =>
  values(
    `SELECT (role_ids #>> '{}') || ' ' || (actions #>> '{}') AS value FROM core.access_rule WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([value]) => value));

const labelOverride = (id: string, label: string) =>
  Effect.gen(function* setLabel() {
    const [version] = yield* values(
      "SELECT version::text AS value FROM core.field WHERE id = $1::uuid",
      [id]
    );

    return yield* editDefinition({
      actorId: ADMIN,
      changes: { label },
      id,
      version: Number(version),
    });
  });

const doctorExit = runDoctor().pipe(
  Effect.map((report) => ({
    errors: report.findings.filter((entry) => entry.severity !== "info"),
    exitCode: report.exitCode,
  }))
);

const of = (severity: Finding["severity"]): Finding =>
  finding(1, severity, "code", "message");

describe("config-upgrade", () => {
  it("doctor exits 0 when clean, 1 on any error and 2 for warnings only", () => {
    assert.strictEqual(exitCodeOf([of("info")]), 0);
    assert.strictEqual(exitCodeOf([of("warning"), of("info")]), 2);
    assert.strictEqual(exitCodeOf([of("warning"), of("error")]), 1);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "fixture v1 to v2: conflicts, converged overrides, security changes, an idempotent rerun",
      () =>
        Effect.gen(function* gateFixture() {
          const installed = yield* runUpgrade({ sets: [FIXTURE.v1] });

          assert.deepStrictEqual(
            installed.sets.map((set) => [set.name, set.result.state]),
            [
              ["core", "completed"],
              ["fx", "completed"],
            ]
          );

          yield* labelOverride(FX.x, "X local");

          assert.strictEqual(
            yield* latestRevisionLabel(FX.x),
            `${yield* currentRevision} X local`,
            "effective record and definition revision commit together"
          );

          yield* labelOverride(FX.w, "W local");

          assert.deepStrictEqual(yield* overridesOf(FX.x), [
            "label=X local@X v1",
          ]);
          assert.strictEqual(yield* fieldLabel(FX.x), "X local");

          const plan = yield* planUpgrade({ sets: [FIXTURE.v2] });
          const fx = plan.sets.find((set) => set.name === "fx");

          assert.deepStrictEqual(plan.refusals, []);
          assert.strictEqual(fx?.fromVersion, 1);
          assert.strictEqual(fx?.toVersion, 2);
          assert.deepStrictEqual(
            fx?.conflicts.map((entry) => [
              entry.recordId,
              entry.property,
              entry.oldShipped,
              entry.newShipped,
              entry.local,
            ]),
            [[FX.x, "label", "X v1", "X v2", "X local"]]
          );
          assert.deepStrictEqual(
            fx?.converged.map((entry) => [entry.recordId, entry.property]),
            [[FX.w, "label"]]
          );
          assert.deepStrictEqual(
            plan.security
              .map((entry) => `${entry.change} ${entry.kind} ${entry.id}`)
              .toSorted(),
            [
              `created role ${FX.approver}`,
              `renamed role ${FX.reviewer}`,
              `updated accessRule ${FX.ruleRecords}`,
            ].toSorted()
          );

          const report = yield* runUpgrade({
            expectedPlanHash: plan.hash,
            sets: [FIXTURE.v2],
          });

          assert.deepStrictEqual(report.plan, plan, "the run applies the plan");
          assert.strictEqual(yield* fieldLabel(FX.z), "Z v2");
          assert.strictEqual(yield* fieldLabel(FX.x), "X local");
          assert.strictEqual(yield* fieldLabel(FX.w), "W local");
          assert.deepStrictEqual(yield* conflictsOf(FX.x), [
            "open - label X v1>X v2 X local",
          ]);
          assert.deepStrictEqual(yield* overridesOf(FX.w), []);
          assert.deepStrictEqual(yield* conflictsOf(FX.w), [
            "resolved converged label W v1>W local W local",
          ]);
          assert.deepStrictEqual(yield* roleName(FX.reviewer), ["auditor"]);
          assert.deepStrictEqual(yield* roleName(FX.approver), ["approver"]);
          assert.strictEqual(
            yield* ruleRolesAndActions(FX.ruleRecords),
            `["${FX.reviewer}"] ["read", "update"]`,
            "the rule still names the renamed role by ID"
          );

          const revision = yield* currentRevision;
          const rerun = yield* runUpgrade({ sets: [FIXTURE.v2] });

          assert.deepStrictEqual(
            rerun.sets.map((set) => set.result.state),
            ["unchanged", "unchanged"]
          );
          assert.deepStrictEqual(rerun.plan.security, []);
          assert.strictEqual(yield* currentRevision, revision);
          assert.deepStrictEqual(yield* doctorExit, {
            errors: [],
            exitCode: 0,
          });

          const [conflict] = yield* openConflictIds;

          yield* resolveConflict({
            actorId: ADMIN,
            conflictId: conflict ?? "",
            resolution: "keep_local",
          });

          assert.deepStrictEqual(yield* overridesOf(FX.x), [
            "label=X local@X v2",
          ]);

          const v3 = yield* runUpgrade({ sets: [FIXTURE.v3] });

          assert.deepStrictEqual(
            v3.plan.sets.find((set) => set.name === "fx")?.conflicts,
            []
          );
          assert.strictEqual(yield* fieldLabel(FX.x), "X local");
          assert.strictEqual(yield* fieldLabel(FX.z), "Z v3");
          assert.deepStrictEqual(yield* openConflictIds, []);
          assert.deepStrictEqual(yield* doctorExit, {
            errors: [],
            exitCode: 0,
          });
        })
    );
  });
});
