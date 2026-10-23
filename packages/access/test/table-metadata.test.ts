/**
 * The metadata builder (Contracts 6.3) over the in-memory core and acme
 * sets: per caller, exactly the fields the caller can read, with read and
 * write states, and nothing of a table or rule the caller cannot see.
 */
import { assert, describe, it } from "@effect/vitest";
import type { Definition } from "@std/definitions/definition";
import type { MetaTable } from "@std/definitions/table-metadata";
import { BUILT_IN_ROLE_IDS, USER_CLASS_ID } from "@std/definitions/well-known";

import { ACME } from "../../testing/src/acme-ids.ts";
import type { Caller } from "../src/rules.ts";
import { tableMetadata } from "../src/table-metadata.ts";
import { coreAndAcme } from "./acme-snapshot.ts";

const snapshot = coreAndAcme();

const alice: Caller = {
  roleIds: [BUILT_IN_ROLE_IDS.authenticated, ACME.assetManager],
};

const bob: Caller = {
  roleIds: [BUILT_IN_ROLE_IDS.authenticated, ACME.employee],
};

const admin: Caller = { roleIds: [BUILT_IN_ROLE_IDS.admin] };
const nobody: Caller = { roleIds: [] };

const metadataOf = (
  caller: Caller,
  classId: string,
  base = snapshot
): MetaTable => {
  const table = tableMetadata(base, caller, classId);

  if (table === undefined) {
    throw new Error(`no metadata for ${classId}`);
  }

  return table;
};

// Fields come in schema order (root's first, each class's by ID); the
// tests compare sets.
const fieldNames = (table: MetaTable): string[] =>
  table.fields.map((field) => field.name).toSorted();

const sorted = (names: readonly string[]): string[] => names.toSorted();

const fieldOf = (table: MetaTable, name: string) => {
  const found = table.fields.find((field) => field.name === name);

  if (found === undefined) {
    throw new Error(`no field ${name}`);
  }

  return found;
};

const states = (table: MetaTable) =>
  Object.fromEntries(
    table.fields.map((field) => [
      field.name,
      `${field.read}/${field.write.create}/${field.write.update}`,
    ])
  );

const ASSET_FIELDS = [
  "name",
  "owner",
  "status",
  "cost",
  "purchased_on",
  "docked_to",
];

describe("table metadata", () => {
  it("lists exactly what Bob can read on acme.asset, with read and write states", () => {
    const table = metadataOf(bob, ACME.asset);

    assert.deepStrictEqual(
      fieldNames(table),
      sorted(ASSET_FIELDS.filter((name) => name !== "cost"))
    );
    assert.deepStrictEqual(states(table), {
      docked_to: "perRecord/perRecord/perRecord",
      name: "yes/perRecord/perRecord",
      owner: "yes/perRecord/perRecord",
      purchased_on: "perRecord/no/no",
      status: "yes/perRecord/perRecord",
    });
    assert.strictEqual(table.creatable, true);
    assert.strictEqual(table.displayField, "name");
    assert.deepStrictEqual(table.ancestors, []);
    assert.deepStrictEqual(table.formRules, []);
  });

  it("gives Alice every asset field, always readable and writable", () => {
    const table = metadataOf(alice, ACME.asset);

    assert.deepStrictEqual(fieldNames(table), sorted(ASSET_FIELDS));
    assert.isTrue(
      table.fields.every(
        (field) =>
          field.read === "yes" &&
          field.write.create === "yes" &&
          field.write.update === "yes"
      )
    );
  });

  it("shows child-only fields per endpoint and inherited fields with their table", () => {
    const laptop = metadataOf(bob, ACME.laptop);

    assert.deepStrictEqual(
      fieldNames(laptop),
      sorted([...ASSET_FIELDS.filter((name) => name !== "cost"), "serial"])
    );
    assert.strictEqual(fieldOf(laptop, "name").inheritedFrom, "acme.asset");
    assert.isNull(fieldOf(laptop, "serial").inheritedFrom);
    assert.deepStrictEqual(laptop.ancestors, [
      { id: ACME.asset, label: "Asset", name: "acme.asset" },
    ]);
    // Rule 9 denies Bob updating status on laptops.
    assert.strictEqual(fieldOf(laptop, "status").write.update, "no");
    assert.strictEqual(
      fieldOf(laptop, "purchased_on").required,
      true,
      "the laptop override makes purchased_on required"
    );

    const adminLaptop = metadataOf(admin, ACME.laptop);

    assert.include(fieldNames(adminLaptop), "disk_key");
    assert.notInclude(fieldNames(metadataOf(bob, ACME.asset)), "serial");
  });

  it("names reference targets only when the caller knows the table", () => {
    const table = metadataOf(bob, ACME.asset);

    assert.deepStrictEqual(fieldOf(table, "owner").type, {
      kind: "reference",
      target: "core.user",
    });

    assert.isUndefined(tableMetadata(snapshot, nobody, ACME.asset));
    assert.isUndefined(tableMetadata(snapshot, nobody, USER_CLASS_ID));
  });

  it("lists each reference that can point at the table once, on the most general table", () => {
    const docked = {
      field: "docked_to",
      fieldLabel: fieldOf(metadataOf(bob, ACME.asset), "docked_to").label,
      label: "Asset",
      table: "acme.asset",
    };

    // `docked_to` targets assets, so laptops and monitors are its targets
    // too; it is declared on asset, whose endpoint lists every asset.
    for (const caller of [alice, bob, admin]) {
      for (const classId of [ACME.asset, ACME.laptop, ACME.monitor]) {
        assert.deepStrictEqual(
          metadataOf(caller, classId).relatedLists,
          [docked],
          classId
        );
      }
    }

    // `owner` points at users: Bob opens `core.user` and sees it there.
    assert.deepStrictEqual(
      metadataOf(bob, USER_CLASS_ID).relatedLists.filter(
        (entry) => entry.table === "acme.asset"
      ),
      [
        {
          field: "owner",
          fieldLabel: fieldOf(metadataOf(bob, ACME.asset), "owner").label,
          label: "Asset",
          table: "acme.asset",
        },
      ]
    );
  });

  it("never contains an access-rule condition, a hidden field or a hidden field's ID", () => {
    const text = JSON.stringify(metadataOf(bob, ACME.asset));

    assert.notInclude(text, ACME.cost);
    assert.notInclude(text, '"cost"');
    assert.notInclude(text, '"op"');
    assert.notInclude(text, "2000");
  });

  it("lists choices of readable fields and only readable, active fields in layouts", () => {
    const base = snapshot.definitions();
    const status = snapshot.field(ACME.status);

    if (status === undefined) {
      throw new Error("no status field");
    }

    const common = {
      owner: { layer: "local" },
      protected: false,
      state: "active",
      version: 1,
    } as const;

    const changed = snapshot.with(
      { changeSetId: snapshot.changeSetId, revision: 2 },
      [
        ...base,
        { ...status, type: { kind: "choice" } } satisfies Definition,
        {
          ...common,
          fieldId: ACME.status,
          hidden: false,
          id: "00000000-0000-4000-8000-0000000000c1",
          key: "in_use",
          kind: "choice",
          label: "In use",
          order: 1,
        },
        {
          ...common,
          fieldId: ACME.status,
          hidden: true,
          id: "00000000-0000-4000-8000-0000000000c2",
          key: "lost",
          kind: "choice",
          label: "Lost",
          order: 2,
        },
        {
          ...common,
          classId: ACME.asset,
          elements: [
            { kind: "section", label: "Money" },
            { fieldId: ACME.cost, kind: "field" },
            { kind: "section", label: "Main" },
            { fieldId: ACME.name, kind: "field" },
            { fieldId: ACME.status, kind: "field" },
          ],
          id: "00000000-0000-4000-8000-0000000000d1",
          kind: "layout",
          type: "form",
        },
      ]
    );

    const bobTable = metadataOf(bob, ACME.laptop, changed);

    assert.deepStrictEqual(fieldOf(bobTable, "status").choices, [
      { key: "in_use", label: "In use", order: 1, retired: false },
      { key: "lost", label: "Lost", order: 2, retired: true },
    ]);
    assert.deepStrictEqual(bobTable.layouts.form, [
      { kind: "section", label: "Main" },
      { field: "name", fieldId: ACME.name, kind: "field" },
      { field: "status", fieldId: ACME.status, kind: "field" },
    ]);
    assert.isNull(bobTable.layouts.list);

    const aliceTable = metadataOf(alice, ACME.asset, changed);

    assert.deepStrictEqual(aliceTable.layouts.form?.slice(0, 2), [
      { kind: "section", label: "Money" },
      { field: "cost", fieldId: ACME.cost, kind: "field" },
    ]);
  });

  it("delivers inherited form rules with never-readable condition fields simplified away", () => {
    const changed = snapshot.with(
      { changeSetId: snapshot.changeSetId, revision: 2 },
      [
        {
          active: true,
          classId: ACME.asset,
          condition: { arg: { path: [ACME.cost] }, op: "empty" },
          fieldId: ACME.name,
          id: "00000000-0000-4000-8000-0000000000f1",
          kind: "formRule",
          name: "name_when_cost_empty",
          order: 10,
          owner: { layer: "local" },
          property: "required",
          protected: false,
          state: "active",
          value: true,
          version: 1,
        },
        {
          active: true,
          classId: ACME.asset,
          condition: null,
          fieldId: ACME.cost,
          id: "00000000-0000-4000-8000-0000000000f2",
          kind: "formRule",
          name: "hidden_cost_rule",
          order: 20,
          owner: { layer: "local" },
          property: "readOnly",
          protected: false,
          state: "active",
          value: true,
          version: 1,
        },
      ]
    );

    const bobRules = metadataOf(bob, ACME.laptop, changed).formRules;
    assert.strictEqual(bobRules.length, 1);
    assert.deepStrictEqual(bobRules[0]?.condition, { op: "true" });
    assert.notInclude(JSON.stringify(bobRules), ACME.cost);
    const aliceRules = metadataOf(alice, ACME.laptop, changed).formRules;
    assert.strictEqual(aliceRules.length, 2);
    assert.deepStrictEqual(aliceRules[0]?.condition, {
      arg: { path: [ACME.cost] },
      op: "empty",
    });
  });
});
