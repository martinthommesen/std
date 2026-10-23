/**
 * The metadata builder (Contracts 6.3) over the in-memory core and acme
 * sets: per caller, exactly the fields the caller can read, with read and
 * write states, and nothing of a table or rule the caller cannot see.
 */
import { assert, describe, it } from "@effect/vitest";
import type { Definition } from "@std/definitions/definition";
import type { MetaTable } from "@std/definitions/table-metadata";
import { BUILT_IN_ROLE_IDS, USER_CLASS_ID } from "@std/definitions/well-known";

import type { Caller } from "../src/rules.ts";
import { tableMetadata } from "../src/table-metadata.ts";
import { coreAndAcme } from "./acme-snapshot.ts";

const snapshot = coreAndAcme();

const CLASS = {
  asset: "989151bb-a69f-4b18-b73d-9e19a4e7514c",
  laptop: "6a365314-6d1b-4e4d-b166-73f29f808504",
  monitor: "87363f0e-8122-4569-8fc8-ec8c5277a71b",
} as const;

const ASSET_MANAGER = "081e3ce8-26a8-43a2-bc58-838d40b4c22d";
const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const STATUS = "5ed5f951-f6da-47ed-967a-c726af083d44";
const NAME = "6438aa02-739d-46c0-94cc-ecea44488210";
const COST = "6dfdc15e-7b81-40ba-aaac-6d7ad5a0d717";

const alice: Caller = {
  roleIds: [BUILT_IN_ROLE_IDS.authenticated, ASSET_MANAGER],
};

const bob: Caller = { roleIds: [BUILT_IN_ROLE_IDS.authenticated, EMPLOYEE] };
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
    const table = metadataOf(bob, CLASS.asset);

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
    const table = metadataOf(alice, CLASS.asset);

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
    const laptop = metadataOf(bob, CLASS.laptop);

    assert.deepStrictEqual(
      fieldNames(laptop),
      sorted([...ASSET_FIELDS.filter((name) => name !== "cost"), "serial"])
    );
    assert.strictEqual(fieldOf(laptop, "name").inheritedFrom, "acme.asset");
    assert.isNull(fieldOf(laptop, "serial").inheritedFrom);
    assert.deepStrictEqual(laptop.ancestors, [
      { id: CLASS.asset, label: "Asset", name: "acme.asset" },
    ]);
    // Rule 9 denies Bob updating status on laptops.
    assert.strictEqual(fieldOf(laptop, "status").write.update, "no");
    assert.strictEqual(
      fieldOf(laptop, "purchased_on").required,
      true,
      "the laptop override makes purchased_on required"
    );

    const adminLaptop = metadataOf(admin, CLASS.laptop);

    assert.include(fieldNames(adminLaptop), "disk_key");
    assert.notInclude(fieldNames(metadataOf(bob, CLASS.asset)), "serial");
  });

  it("names reference targets only when the caller knows the table", () => {
    const table = metadataOf(bob, CLASS.asset);

    assert.deepStrictEqual(fieldOf(table, "owner").type, {
      kind: "reference",
      target: "core.user",
    });

    assert.isUndefined(tableMetadata(snapshot, nobody, CLASS.asset));
    assert.isUndefined(tableMetadata(snapshot, nobody, USER_CLASS_ID));
  });

  it("lists each reference that can point at the table once, on the most general table", () => {
    const docked = {
      field: "docked_to",
      fieldLabel: fieldOf(metadataOf(bob, CLASS.asset), "docked_to").label,
      label: "Asset",
      table: "acme.asset",
    };

    // `docked_to` targets assets, so laptops and monitors are its targets
    // too; it is declared on asset, whose endpoint lists every asset.
    for (const caller of [alice, bob, admin]) {
      for (const classId of Object.values(CLASS)) {
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
          fieldLabel: fieldOf(metadataOf(bob, CLASS.asset), "owner").label,
          label: "Asset",
          table: "acme.asset",
        },
      ]
    );
  });

  it("never contains an access-rule condition, a hidden field or a hidden field's ID", () => {
    const text = JSON.stringify(metadataOf(bob, CLASS.asset));

    assert.notInclude(text, COST);
    assert.notInclude(text, '"cost"');
    assert.notInclude(text, '"op"');
    assert.notInclude(text, "2000");
  });

  it("lists choices of readable fields and only readable, active fields in layouts", () => {
    const base = snapshot.definitions();
    const status = snapshot.field(STATUS);

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
          fieldId: STATUS,
          hidden: false,
          id: "00000000-0000-4000-8000-0000000000c1",
          key: "in_use",
          kind: "choice",
          label: "In use",
          order: 1,
        },
        {
          ...common,
          fieldId: STATUS,
          hidden: true,
          id: "00000000-0000-4000-8000-0000000000c2",
          key: "lost",
          kind: "choice",
          label: "Lost",
          order: 2,
        },
        {
          ...common,
          classId: CLASS.asset,
          elements: [
            { kind: "section", label: "Money" },
            { fieldId: COST, kind: "field" },
            { kind: "section", label: "Main" },
            { fieldId: NAME, kind: "field" },
            { fieldId: STATUS, kind: "field" },
          ],
          id: "00000000-0000-4000-8000-0000000000d1",
          kind: "layout",
          type: "form",
        },
      ]
    );

    const bobTable = metadataOf(bob, CLASS.laptop, changed);

    assert.deepStrictEqual(fieldOf(bobTable, "status").choices, [
      { key: "in_use", label: "In use", order: 1, retired: false },
      { key: "lost", label: "Lost", order: 2, retired: true },
    ]);
    assert.deepStrictEqual(bobTable.layouts.form, [
      { kind: "section", label: "Main" },
      { field: "name", fieldId: NAME, kind: "field" },
      { field: "status", fieldId: STATUS, kind: "field" },
    ]);
    assert.isNull(bobTable.layouts.list);

    const aliceTable = metadataOf(alice, CLASS.asset, changed);

    assert.deepStrictEqual(aliceTable.layouts.form?.slice(0, 2), [
      { kind: "section", label: "Money" },
      { field: "cost", fieldId: COST, kind: "field" },
    ]);
  });

  it("delivers inherited form rules with never-readable condition fields simplified away", () => {
    const changed = snapshot.with(
      { changeSetId: snapshot.changeSetId, revision: 2 },
      [
        {
          active: true,
          classId: CLASS.asset,
          condition: { arg: { path: [COST] }, op: "empty" },
          fieldId: NAME,
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
          classId: CLASS.asset,
          condition: null,
          fieldId: COST,
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

    const bobRules = metadataOf(bob, CLASS.laptop, changed).formRules;
    assert.strictEqual(bobRules.length, 1);
    assert.deepStrictEqual(bobRules[0]?.condition, { op: "true" });
    assert.notInclude(JSON.stringify(bobRules), COST);
    const aliceRules = metadataOf(alice, CLASS.laptop, changed).formRules;
    assert.strictEqual(aliceRules.length, 2);
    assert.deepStrictEqual(aliceRules[0]?.condition, {
      arg: { path: [COST] },
      op: "empty",
    });
  });
});
