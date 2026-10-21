import { assert, describe, it } from "@effect/vitest";
import { isFailure, isSuccess } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type { Condition } from "../src/condition.ts";
import type {
  AccessRuleDefinition,
  RoleDefinition,
} from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import { effectiveJson } from "../src/effective-json.ts";
import { effectiveFields } from "../src/effective-schema.ts";
import { generatedName, parseGeneratedName } from "../src/ids.ts";
import {
  fieldNameProblem,
  IDENTIFIER_MAX_BYTES,
  namespaceNameProblem,
  tableNameProblem,
} from "../src/names.ts";
import { validateSnapshot } from "../src/validate.ts";
import {
  field,
  freshId,
  KEY,
  namespace,
  override,
  snapshotOf,
  table,
} from "./fixtures.ts";

const hierarchy = () => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const laptop = table(ns, "laptop", asset);
  const gaming = table(ns, "gaming_laptop", laptop);
  const monitor = table(ns, "monitor", asset);

  const name = field(
    asset,
    "name",
    { kind: "text", maxLength: 100 },
    { required: true }
  );

  const purchased = field(asset, "purchased_on", { kind: "date" });

  const cost = field(asset, "cost", {
    kind: "decimal",
    precision: 12,
    scale: 2,
  });

  const serial = field(laptop, "serial");

  return { asset, cost, gaming, laptop, monitor, name, ns, purchased, serial };
};

describe("definitions-snapshot", () => {
  it("names follow the identifier rules", () => {
    assert.isUndefined(fieldNameProblem("purchased_on"));
    assert.strictEqual(fieldNameProblem("class"), "reserved");
    assert.strictEqual(fieldNameProblem("created_by"), "reserved");
    assert.strictEqual(fieldNameProblem("Name"), "invalidCharacters");
    assert.strictEqual(fieldNameProblem("1st"), "invalidCharacters");
    assert.isUndefined(fieldNameProblem("a".repeat(IDENTIFIER_MAX_BYTES)));
    assert.strictEqual(
      fieldNameProblem("a".repeat(IDENTIFIER_MAX_BYTES + 1)),
      "tooLong"
    );
    assert.strictEqual(tableNameProblem("std_ix_x"), "reservedPrefix");
    assert.strictEqual(namespaceNameProblem("public"), "reserved");
    assert.strictEqual(namespaceNameProblem("pg_temp"), "reservedPrefix");
  });

  it("generated names are std_<kind>_<32 hex> and parse back", () => {
    const id = "0192c4e7-7a3b-7c1d-9a2e-3f4b5c6d7e8f";
    const name = generatedName("ix", id);

    assert.strictEqual(name, "std_ix_0192c4e77a3b7c1d9a2e3f4b5c6d7e8f");
    assert.isAtMost(name.length, IDENTIFIER_MAX_BYTES);
    assert.deepStrictEqual(parseGeneratedName(name), { id, kind: "ix" });
  });

  it("knows ancestors, subtrees and inherited fields", () => {
    const h = hierarchy();

    const snapshot = snapshotOf([
      h.ns,
      h.asset,
      h.laptop,
      h.gaming,
      h.monitor,
      h.name,
      h.purchased,
      h.cost,
      h.serial,
    ]);

    assert.deepStrictEqual(
      snapshot.ancestors(h.gaming.id).map((c) => c.name),
      ["asset", "laptop"]
    );
    assert.deepStrictEqual(
      new Set(snapshot.subtreeIds(h.asset.id)),
      new Set([h.asset.id, h.laptop.id, h.gaming.id, h.monitor.id])
    );
    assert.deepStrictEqual(snapshot.subtreeIds(h.monitor.id), [h.monitor.id]);
    assert.strictEqual(snapshot.root(h.gaming.id)?.id, h.asset.id);
    assert.strictEqual(snapshot.depth(h.gaming.id), 2);
    assert.strictEqual(snapshot.classByName("acme.laptop")?.id, h.laptop.id);
    assert.strictEqual(
      snapshot.fieldByName(h.gaming.id, "serial")?.id,
      h.serial.id
    );
    assert.isUndefined(snapshot.fieldByName(h.monitor.id, "serial"));
    assert.lengthOf(snapshot.hierarchyFields(h.monitor.id), 4);
    assert.lengthOf(validateSnapshot(snapshot), 0);
  });

  it("stacks overrides down the chain and only tightens", () => {
    const h = hierarchy();
    const laptopRequired = override(h.laptop, h.purchased, { required: true });

    const gamingShorter = override(h.gaming, h.name, {
      label: "Gamer tag",
      maxLength: 20,
    });

    const snapshot = snapshotOf([
      h.ns,
      h.asset,
      h.laptop,
      h.gaming,
      h.monitor,
      h.name,
      h.purchased,
      h.cost,
      h.serial,
      laptopRequired,
      gamingShorter,
    ]);

    const byName = (classId: string) =>
      new Map(effectiveFields(snapshot, classId).map((f) => [f.field.name, f]));

    assert.isFalse(byName(h.asset.id).get("purchased_on")?.required);
    assert.isTrue(byName(h.laptop.id).get("purchased_on")?.required);
    assert.isTrue(byName(h.gaming.id).get("purchased_on")?.required);
    assert.isFalse(byName(h.monitor.id).get("purchased_on")?.required);
    assert.deepStrictEqual(byName(h.gaming.id).get("name")?.type, {
      kind: "text",
      maxLength: 20,
    });
    assert.strictEqual(byName(h.gaming.id).get("name")?.label, "Gamer tag");
    assert.lengthOf(validateSnapshot(snapshot), 0);

    const loosening = snapshotOf([
      h.ns,
      h.asset,
      h.laptop,
      h.gaming,
      h.name,
      h.purchased,
      laptopRequired,
      override(h.gaming, h.purchased, { required: false }),
      override(h.laptop, h.name, { maxLength: 200 }),
    ]);

    assert.deepStrictEqual(
      validateSnapshot(loosening).map((p) => p.code),
      ["overrideLoosens", "overrideLoosens"]
    );
  });

  it("refuses duplicate field names in a hierarchy, retired fields included", () => {
    const h = hierarchy();

    const clash = field(
      h.monitor,
      "serial",
      { kind: "text" },
      { state: "retired" }
    );

    const shadow = field(h.laptop, "cost", { kind: "integer" });

    const problems = validateSnapshot(
      snapshotOf([
        h.ns,
        h.asset,
        h.laptop,
        h.monitor,
        h.cost,
        h.serial,
        clash,
        shadow,
      ])
    );

    assert.deepStrictEqual(
      problems.map((p) => p.code),
      ["duplicateName", "duplicateName"]
    );
  });

  it("refuses a password or secret display field", () => {
    const ns = namespace("acme");
    const account = table(ns, "account");
    const secret = field(account, "pin", { kind: "password" });
    const name = field(account, "name");

    const codes = (displayFieldId: string) =>
      validateSnapshot(
        snapshotOf([ns, { ...account, displayFieldId }, secret, name])
      ).map((p) => p.code);

    assert.deepStrictEqual(codes(secret.id), ["invalidDisplayField"]);
    assert.deepStrictEqual(codes(name.id), []);
  });

  it("refuses extends cycles, reserved names and bad defaults", () => {
    const ns = namespace("acme");
    const a = table(ns, "a");
    const b = table(ns, "b", a);
    const cyclic = { ...a, parentId: b.id };
    const reserved = field(b, "version");
    const badDefault = field(b, "count", { kind: "integer" }, { default: "x" });

    const passwordDefault = field(
      b,
      "secret_word",
      { kind: "password" },
      { default: "x" }
    );

    const codes = validateSnapshot(
      snapshotOf([ns, cyclic, b, reserved, badDefault, passwordDefault])
    ).map((p) => p.code);

    assert.includeMembers(codes, [
      "extendsCycle",
      "invalidName",
      "invalidDefault",
      "defaultNotAllowed",
    ]);
  });

  it("applies operations with version checks and drops no-ops", () => {
    const h = hierarchy();
    const snapshot = snapshotOf([h.ns, h.asset, h.name]);
    const next = { changeSetId: KEY.changeSetId, revision: 2 };

    const relabel = applyOperations(
      snapshot,
      [
        {
          changes: { label: "Asset name" },
          id: h.name.id,
          op: "update",
          version: 1,
        },
      ],
      next
    );

    assert.isTrue(isSuccess(relabel));

    if (isSuccess(relabel)) {
      assert.strictEqual(relabel.success.changes[0]?.after.version, 2);
      assert.strictEqual(
        relabel.success.after.field(h.name.id)?.label,
        "Asset name"
      );
    }

    const unchanged = applyOperations(
      snapshot,
      [{ changes: { label: "name" }, id: h.name.id, op: "update", version: 1 }],
      next
    );

    assert.isTrue(isSuccess(unchanged));

    if (isSuccess(unchanged)) {
      assert.lengthOf(unchanged.success.changes, 0);
    }

    const stale = applyOperations(
      snapshot,
      [{ changes: { label: "X" }, id: h.name.id, op: "update", version: 7 }],
      next
    );

    assert.isTrue(isFailure(stale));

    if (isFailure(stale)) {
      assert.strictEqual(stale.failure.problems[0]?.code, "versionConflict");
    }

    const typeChange = applyOperations(
      snapshot,
      [
        {
          changes: { type: { kind: "integer" } },
          id: h.name.id,
          op: "update",
          version: 1,
        },
      ],
      next
    );

    assert.isTrue(isFailure(typeChange));
  });

  it("checks access-rule conditions with the condition engine", () => {
    const h = hierarchy();

    const role: RoleDefinition = {
      helpText: null,
      id: freshId(),
      kind: "role",
      label: "Employee",
      name: "employee",
      owner: { layer: "local" },
      protected: false,
      state: "active",
      version: 1,
    };

    const rule = (condition: Condition): AccessRuleDefinition => ({
      actions: ["read"],
      active: true,
      classId: h.laptop.id,
      condition,
      description: null,
      effect: "deny",
      id: freshId(),
      kind: "accessRule",
      owner: { layer: "local" },
      protected: false,
      roleIds: [role.id],
      state: "active",
      target: { kind: "records" },
      version: 1,
    });

    const base = [h.ns, h.asset, h.laptop, h.name, h.cost, h.serial, role];

    const valid = rule({
      left: { path: [h.cost.id] },
      op: "gt",
      right: { value: "2000" },
    });

    const textOrder = rule({
      left: { path: [h.name.id] },
      op: "lt",
      right: { value: "x" },
    });

    const childOnly = rule({ arg: { path: [h.serial.id] }, op: "empty" });

    assert.lengthOf(validateSnapshot(snapshotOf([...base, valid])), 0);
    assert.deepStrictEqual(
      validateSnapshot(snapshotOf([...base, textOrder])).map((p) => p.code),
      ["invalidCondition"]
    );
    assert.lengthOf(validateSnapshot(snapshotOf([...base, childOnly])), 0);
    assert.deepStrictEqual(
      validateSnapshot(
        snapshotOf([...base, { ...childOnly, classId: h.asset.id }])
      ).map((p) => p.code),
      ["invalidCondition"]
    );
  });

  it("lists dependencies and effective JSON without bookkeeping", () => {
    const h = hierarchy();

    const ref = field(h.laptop, "docked_to", {
      kind: "reference",
      targetClassId: h.asset.id,
    });

    assert.deepStrictEqual(
      dependenciesOf(ref).map((d) => [d.kind, d.toId]),
      [
        ["field_of", h.laptop.id],
        ["references_table", h.asset.id],
      ]
    );
    assert.deepStrictEqual(
      dependenciesOf(h.laptop).map((d) => d.kind),
      ["extends"]
    );

    const json = effectiveJson(h.name);

    assert.notProperty(json, "version");
    assert.notProperty(json, "enforcement");
    assert.propertyVal(json, "name", "name");
  });
});
