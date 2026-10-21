import { assert, describe, it } from "@effect/vitest";
/**
 * The set upgrade planner (Contracts 8.4), in memory: overrides carried
 * across shipped changes (kept, converged, conflict), removals through the
 * lifecycle operations with local dependents reported, renames, name
 * clashes and downgrades.
 */
import { isFailure, isSuccess } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type { AccessRuleDraft } from "../src/definition.ts";
import { EMPTY_LAYERS } from "../src/layers.ts";
import type { LayerState, LocalOverride } from "../src/layers.ts";
import type { NamedSetFile, SetFile } from "../src/set-file.ts";
import { decodeSetFile, resolveSet } from "../src/set-resolve.ts";
import { NO_LIFECYCLE, planSetUpgrade } from "../src/set-upgrade.ts";
import type { LifecycleOperations, SetUpgrade } from "../src/set-upgrade.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";

const SET = "11111111-1111-4111-8111-111111111111";
const NAMESPACE = "11111111-1111-4111-8111-000000000001";
const TABLE = "11111111-1111-4111-8111-000000000002";
const LABELLED = "11111111-1111-4111-8111-000000000003";
const DROPPED = "11111111-1111-4111-8111-000000000004";
const LOCAL_RULE = "11111111-1111-4111-8111-000000000005";
const LOCAL_ROLE = "11111111-1111-4111-8111-000000000006";

const fileOf = (version: number, fields: SetFile["tables"]): NamedSetFile => {
  const decoded = decodeSetFile("set.yaml", {
    namespaces: [{ id: NAMESPACE, name: "t" }],
    set: { id: SET, layer: "app", name: "t", version },
    tables: fields ?? [],
  });

  if (isFailure(decoded)) {
    throw decoded.failure;
  }

  return decoded.success;
};

const tableWith = (
  name: string,
  fields: readonly { id: string; name: string; label: string }[]
): SetFile["tables"] => [
  {
    fields: fields.map((entry) => ({ ...entry, type: "text" })),
    id: TABLE,
    name,
  },
];

const V1 = fileOf(
  1,
  tableWith("t.item", [
    { id: LABELLED, label: "One", name: "labelled" },
    { id: DROPPED, label: "Dropped", name: "dropped" },
  ])
);

/** The state after installing a set, with nothing local. */
interface Installed {
  readonly snapshot: ConfigSnapshot;
  readonly layers: LayerState;
}

const plan = (
  file: NamedSetFile,
  installed: Installed,
  lifecycle: LifecycleOperations = NO_LIFECYCLE
): SetUpgrade => {
  const resolved = resolveSet([file], installed.snapshot);

  if (isFailure(resolved)) {
    throw resolved.failure;
  }

  return planSetUpgrade({
    hash: `hash-${resolved.success.header.version}`,
    installed: installed.snapshot,
    key: { changeSetId: "plan", revision: installed.snapshot.revision + 1 },
    layers: installed.layers,
    lifecycle,
    resolved: resolved.success,
  });
};

const EMPTY: Installed = {
  layers: EMPTY_LAYERS,
  snapshot: ConfigSnapshot.empty({ changeSetId: "empty", revision: 0 }),
};

const installV1 = (): Installed => {
  const first = plan(V1, EMPTY);

  if (first.applied === null) {
    throw new Error("v1 did not apply");
  }

  return { layers: first.layersAfter, snapshot: first.applied.after };
};

const withOverride = (
  installed: Installed,
  override: LocalOverride
): Installed => ({
  layers: {
    ...installed.layers,
    overrides: [...installed.layers.overrides, override],
  },
  snapshot: installed.snapshot,
});

const localRuleOn = (fieldId: string): AccessRuleDraft => ({
  actions: ["read"],
  active: true,
  classId: TABLE,
  condition: null,
  description: "Local readers",
  effect: "allow",
  id: LOCAL_RULE,
  kind: "accessRule",
  owner: { layer: "local" },
  protected: false,
  roleIds: [LOCAL_ROLE],
  target: { fields: [fieldId], kind: "fields" },
});

const withLocalRule = (installed: Installed, fieldId: string): Installed => {
  const applied = applyOperations(
    installed.snapshot,
    [
      {
        definition: {
          helpText: null,
          id: LOCAL_ROLE,
          kind: "role",
          label: "Local",
          name: "local",
          owner: { layer: "local" },
          protected: false,
        },
        op: "createRole",
      },
      { definition: localRuleOn(fieldId), op: "createAccessRule" },
    ],
    { changeSetId: "local", revision: installed.snapshot.revision + 1 }
  );

  if (!isSuccess(applied)) {
    throw applied.failure;
  }

  return { layers: installed.layers, snapshot: applied.success.after };
};

describe("set-upgrade", () => {
  it("installs a set as base rows and plans nothing on a rerun", () => {
    const installed = installV1();
    const rerun = plan(V1, installed);

    assert.deepStrictEqual(rerun.operations, []);
    assert.deepStrictEqual(rerun.writes.base, []);
    assert.isUndefined(rerun.writes.set);
    assert.strictEqual(installed.layers.base.size, 4);
  });

  it("keeps an override whose base_when_set equals the incoming value", () => {
    const installed = withOverride(installV1(), {
      baseWhenSet: "Two",
      property: "label",
      recordId: LABELLED,
      value: "Local",
    });

    const v2 = fileOf(
      2,
      tableWith("t.item", [
        { id: LABELLED, label: "Two", name: "labelled" },
        { id: DROPPED, label: "Dropped", name: "dropped" },
      ])
    );

    const upgrade = plan(v2, installed);

    assert.deepStrictEqual(upgrade.report.kept, [
      { local: "Local", property: "label", recordId: LABELLED },
    ]);
    assert.deepStrictEqual(upgrade.report.conflicts, []);
    assert.deepStrictEqual(upgrade.writes.dropOverrides, []);
  });

  it("refuses a removal the lifecycle cannot do, and reports local dependents of one it can", () => {
    const installed = withLocalRule(installV1(), DROPPED);

    const v2 = fileOf(
      2,
      tableWith("t.item", [{ id: LABELLED, label: "One", name: "labelled" }])
    );

    assert.deepStrictEqual(
      plan(v2, installed).report.refusals.map((entry) => entry.code),
      ["removalUnsupported"]
    );

    const retiring = plan(v2, installed, {
      retire: (definition) => ({
        changes: { helpText: "retired" },
        id: definition.id,
        op: "update",
        version: definition.version,
      }),
    });

    assert.deepStrictEqual(retiring.report.refusals, []);
    assert.deepStrictEqual(
      retiring.report.removed.map((entry) => [
        entry.id,
        entry.action,
        entry.localDependents.map((dependent) => [
          dependent.id,
          dependent.dependency,
        ]),
      ]),
      [[DROPPED, "retired", [[LOCAL_RULE, "access_rule_on"]]]]
    );
    assert.isTrue(
      retiring.writes.base.some((row) => row.id === DROPPED && row.removed)
    );
  });

  it("renames by ID through the lifecycle, refuses a downgrade and a name clash", () => {
    const installed = installV1();

    const renamed = fileOf(
      2,
      tableWith("t.thing", [
        { id: LABELLED, label: "One", name: "labelled" },
        { id: DROPPED, label: "Dropped", name: "dropped" },
      ])
    );

    assert.deepStrictEqual(
      plan(renamed, installed).report.refusals.map((entry) => entry.code),
      ["renameUnsupported"]
    );

    const withRename = plan(renamed, installed, {
      rename: (definition) => ({
        changes: { helpText: "renamed" },
        id: definition.id,
        op: "update",
        version: definition.version,
      }),
    });

    assert.deepStrictEqual(
      withRename.report.changes.map((entry) => [entry.id, entry.action]),
      [[TABLE, "renamed"]]
    );

    const upgraded = plan(
      fileOf(
        2,
        tableWith("t.item", [
          { id: LABELLED, label: "One", name: "labelled" },
          { id: DROPPED, label: "Dropped", name: "dropped" },
        ])
      ),
      installed
    );

    if (upgraded.applied === null) {
      throw new Error("v2 did not apply");
    }

    const atV2: Installed = {
      layers: upgraded.layersAfter,
      snapshot: upgraded.applied.after,
    };

    assert.deepStrictEqual(
      plan(V1, atV2).report.refusals.map((entry) => entry.code),
      ["downgrade"]
    );

    const local = withLocalRule(installed, DROPPED);

    const clashing = fileOf(
      3,
      tableWith("t.item", [
        { id: LABELLED, label: "One", name: "labelled" },
        { id: DROPPED, label: "Dropped", name: "dropped" },
      ])
    );

    const role = decodeSetFile("set.yaml", {
      ...clashing.content,
      roles: [{ id: "11111111-1111-4111-8111-000000000007", name: "local" }],
    });

    if (isFailure(role)) {
      throw role.failure;
    }

    assert.deepStrictEqual(
      plan(role.success, local).report.refusals.map((entry) => [
        entry.code,
        entry.details.localId ?? null,
      ]),
      [["nameClash", LOCAL_ROLE]]
    );
  });
});
