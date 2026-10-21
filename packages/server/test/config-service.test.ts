import { assert, describe, it, layer } from "@effect/vitest";
/**
 * The config service (Contracts 8.1, 8.2, 8.4): admin edits of shipped
 * records become overrides of the 8.2 properties only, protected records
 * accept label and help text only, removing an override restores the
 * shipped value, conflicts resolve as `take_shipped` and `replace`, and
 * `adopt` moves a record its set removed into the `local` layer.
 */
import {
  OVERRIDABLE,
  PROTECTED_OVERRIDABLE,
} from "@std/definitions/overridable";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import {
  adopt,
  editDefinition,
  removeOverride,
  resolveConflict,
} from "../src/config/config-service.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import {
  ADMIN,
  conflictsOf,
  FIXTURE,
  FX,
  insertAdmin,
  fieldLabel,
  openConflictIds,
  openConflictOf,
  overridesOf,
  variantOf,
  writeSetDirectory,
} from "./config-support.ts";
import {
  change,
  createRole,
  currentRevision,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { errorOf } from "./support.ts";

/** A protected core access rule: admins may do everything. */
const ADMIN_RECORDS_RULE = "be681045-76e4-4c0f-9220-a36ffb180413";

const versionOf = (table: string, id: string) =>
  values(
    `SELECT version::text AS value FROM core."${table}" WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([version]) => Number(version)));

const edit = (table: string, id: string, changes: JsonObject) =>
  Effect.gen(function* editRecord() {
    return yield* editDefinition({
      actorId: ADMIN,
      changes,
      id,
      version: yield* versionOf(table, id),
    });
  });

const refusalReason = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      const failure = errorOf(exit);

      return failure !== undefined && "reason" in failure
        ? `${failure._tag} ${String(failure.reason)}`
        : failure?._tag;
    })
  );

const ownerOf = (table: string, id: string) =>
  values(
    `SELECT owner_layer || ' ' || active::text AS value FROM core."${table}" WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([value]) => value));

const baseRows = (id: string) =>
  values(
    `SELECT removed::text AS value FROM core."config_base" WHERE id = $1::uuid`,
    [id]
  );

describe("config-service", () => {
  it("lists exactly the overridable properties of Contracts 8.2", () => {
    assert.deepStrictEqual(OVERRIDABLE.field, [
      "default",
      "helpText",
      "label",
      "readOnly",
      "required",
    ]);
    assert.deepStrictEqual(OVERRIDABLE.class, ["displayFieldId", "label"]);
    assert.deepStrictEqual(OVERRIDABLE.role, ["label"]);
    assert.deepStrictEqual(OVERRIDABLE.accessRule, ["active"]);
    assert.deepStrictEqual(PROTECTED_OVERRIDABLE, ["helpText", "label"]);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "admin edits of shipped records are overrides of the 8.2 properties; removing one restores the shipped value",
      () =>
        Effect.gen(function* overrides() {
          yield* runUpgrade({ sets: [FIXTURE.v1] });
          yield* insertAdmin;

          yield* edit("field", FX.x, {
            helpText: "Local help",
            label: "Local X",
          });
          assert.deepStrictEqual(yield* overridesOf(FX.x), [
            "helpText=Local help@null",
            "label=Local X@X v1",
          ]);
          assert.strictEqual(yield* fieldLabel(FX.x), "Local X");

          const revision = yield* currentRevision;

          assert.strictEqual(
            yield* refusalReason(edit("field", FX.x, { name: "renamed" })),
            "ConfigEditRefused notOverridable"
          );
          assert.strictEqual(
            yield* refusalReason(
              edit("field", FX.x, { type: { kind: "longText" } })
            ),
            "ConfigEditRefused notOverridable"
          );
          assert.strictEqual(
            yield* refusalReason(
              edit("access_rule", FX.ruleRecords, { actions: ["read"] })
            ),
            "ConfigEditRefused notOverridable"
          );
          assert.strictEqual(
            yield* currentRevision,
            revision,
            "nothing changed"
          );

          yield* edit("field", FX.z, { readOnly: true });
          assert.deepStrictEqual(yield* overridesOf(FX.z), [
            "readOnly=true@false",
          ]);

          yield* removeOverride({
            actorId: ADMIN,
            id: FX.x,
            property: "label",
          });
          yield* removeOverride({
            actorId: ADMIN,
            id: FX.z,
            property: "readOnly",
          });
          assert.strictEqual(yield* fieldLabel(FX.x), "X v1");
          assert.deepStrictEqual(yield* overridesOf(FX.x), [
            "helpText=Local help@null",
          ]);
          assert.deepStrictEqual(yield* overridesOf(FX.z), []);

          yield* edit("field", FX.x, { helpText: null });
          assert.deepStrictEqual(
            yield* overridesOf(FX.x),
            [],
            "setting the shipped value removes the override"
          );

          yield* change([createRole("local_helper")]);

          const [localRole = ""] = yield* values(
            "SELECT id::text AS value FROM core.role WHERE name = 'local_helper'"
          );

          yield* edit("role", localRole, { name: "local_aide" });
          assert.deepStrictEqual(
            yield* values(
              "SELECT name AS value FROM core.role WHERE id = $1::uuid",
              [localRole]
            ),
            ["local_aide"]
          );
          assert.deepStrictEqual(yield* overridesOf(localRole), []);

          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );

    dbTest.effect(
      "protected records accept only label and help-text overrides",
      () =>
        Effect.gen(function* protectedRecords() {
          yield* edit("role", BUILT_IN_ROLE_IDS.admin, {
            helpText: "Runs this install",
            label: "Admins",
          });
          assert.deepStrictEqual(
            yield* values(
              "SELECT label AS value FROM core.role WHERE id = $1::uuid",
              [BUILT_IN_ROLE_IDS.admin]
            ),
            ["Admins"]
          );
          assert.strictEqual(
            yield* refusalReason(
              edit("role", BUILT_IN_ROLE_IDS.admin, { name: "root" })
            ),
            "DefinitionProtected protected"
          );
          assert.strictEqual(
            yield* refusalReason(
              edit("access_rule", ADMIN_RECORDS_RULE, { active: false })
            ),
            "DefinitionProtected protected",
            "a protected access rule cannot be disabled"
          );
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("conflicts resolve as take_shipped and replace", () =>
      Effect.scoped(
        Effect.gen(function* resolutions() {
          yield* runUpgrade({ sets: [FIXTURE.v1] });
          yield* insertAdmin;
          yield* edit("field", FX.x, { label: "X local" });
          yield* edit("field", FX.z, { label: "Z local" });

          const v2 = yield* writeSetDirectory(
            variantOf(yield* readSetDirectory(FIXTURE.v1), {
              labels: { x: "X v2", z: "Z v2" },
              version: 2,
            })
          );

          yield* runUpgrade({ sets: [v2] });

          const onX = yield* openConflictOf(FX.x);
          const onZ = yield* openConflictOf(FX.z);

          assert.strictEqual(
            yield* refusalReason(
              resolveConflict({
                actorId: ADMIN,
                conflictId: "not-a-conflict",
                resolution: "take_shipped",
              })
            ),
            "ConfigEditRefused conflictNotFound"
          );

          yield* resolveConflict({
            actorId: ADMIN,
            conflictId: onX,
            resolution: "take_shipped",
          });
          yield* resolveConflict({
            actorId: ADMIN,
            conflictId: onZ,
            resolution: "replace",
            value: "Z replaced",
          });

          assert.strictEqual(yield* fieldLabel(FX.x), "X v2");
          assert.deepStrictEqual(yield* overridesOf(FX.x), []);
          assert.deepStrictEqual(yield* conflictsOf(FX.x), [
            "resolved take_shipped label X v1>X v2 X local",
          ]);
          assert.strictEqual(yield* fieldLabel(FX.z), "Z replaced");
          assert.deepStrictEqual(yield* overridesOf(FX.z), [
            "label=Z replaced@Z v2",
          ]);
          assert.deepStrictEqual(yield* conflictsOf(FX.z), [
            "resolved replace label Z v1>Z v2 Z local",
          ]);
          assert.deepStrictEqual(yield* openConflictIds, []);
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
      )
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "adopt moves a record its set removed into the local layer",
      () =>
        Effect.scoped(
          Effect.gen(function* adoptRemoved() {
            yield* runUpgrade({ sets: [FIXTURE.v1] });
            yield* insertAdmin;
            yield* insertAdmin;

            assert.strictEqual(
              yield* refusalReason(
                adopt({ actorId: ADMIN, id: FX.ruleFields })
              ),
              "ConfigEditRefused notAdoptable",
              "a record its set still ships cannot be adopted"
            );

            const withoutRule = variantOf(yield* readSetDirectory(FIXTURE.v1), {
              dropRules: [FX.ruleFields],
              version: 2,
            });

            const report = yield* runUpgrade({
              sets: [yield* writeSetDirectory(withoutRule)],
            });

            assert.deepStrictEqual(
              report.plan.sets
                .find((set) => set.name === "fx")
                ?.removed.map((entry) => [entry.id, entry.action]),
              [[FX.ruleFields, "deactivated"]]
            );
            assert.deepStrictEqual(
              report.plan.security.map((entry) => [entry.id, entry.change]),
              [[FX.ruleFields, "deactivated"]]
            );
            assert.strictEqual(
              yield* ownerOf("access_rule", FX.ruleFields),
              "app false"
            );
            assert.deepStrictEqual(yield* baseRows(FX.ruleFields), ["true"]);

            yield* adopt({ actorId: ADMIN, id: FX.ruleFields });

            assert.strictEqual(
              yield* ownerOf("access_rule", FX.ruleFields),
              "local false"
            );
            assert.deepStrictEqual(yield* baseRows(FX.ruleFields), []);

            const v3 = variantOf(withoutRule, { version: 3 });

            const later = yield* runUpgrade({
              sets: [yield* writeSetDirectory(v3)],
            });

            assert.deepStrictEqual(
              later.plan.sets.find((set) => set.name === "fx")?.removed,
              [],
              "later versions leave the adopted record alone"
            );
            assert.strictEqual(
              yield* ownerOf("access_rule", FX.ruleFields),
              "local false"
            );
            assert.strictEqual((yield* runDoctor()).exitCode, 0);
          })
        )
    );
  });
});
