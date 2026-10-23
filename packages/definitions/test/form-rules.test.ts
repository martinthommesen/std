/** Form-rule definitions share config validation, inheritance, dependencies and ownership. */
import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";

import { applyOperations } from "../src/apply.ts";
import type { FormRuleDefinition } from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import { formRulesOf } from "../src/form-rules.ts";
import { overridableProperties } from "../src/overridable.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";
import { validateSnapshot } from "../src/validate.ts";
import { field, freshId, KEY, namespace, table } from "./fixtures.ts";

const ns = namespace("forms");
const parent = table(ns, "parent");
const child = table(ns, "child", parent);
const sibling = table(ns, "sibling");
const title = field(parent, "title");
const other = field(sibling, "other");

const base = ConfigSnapshot.make(KEY, [
  ns,
  parent,
  child,
  sibling,
  title,
  other,
]);

const rule = (
  name: string,
  extra: Partial<FormRuleDefinition> = {}
): FormRuleDefinition => ({
  active: true,
  classId: parent.id,
  condition: null,
  fieldId: title.id,
  id: freshId(),
  kind: "formRule",
  name,
  order: 0,
  owner: { layer: "local" },
  property: "required",
  protected: false,
  state: "active",
  value: true,
  version: 1,
  ...extra,
});

describe("form rules", () => {
  it("inherits active rules across the lineage and orders ties by stable ID", () => {
    const first = rule("first", { order: 1 });

    const second = rule("second", { classId: child.id, order: 1 });

    const inactive = rule("inactive", { active: false });
    const retired = rule("retired", { state: "retired" });

    const unrelated = rule("unrelated", {
      classId: sibling.id,
      fieldId: other.id,
    });

    const snapshot = base.with(KEY, [
      second,
      unrelated,
      retired,
      inactive,

      first,
    ]);

    assert.deepStrictEqual(
      formRulesOf(snapshot, child.id).map((entry) => entry.id),
      [first.id, second.id]
    );
    assert.deepStrictEqual(
      formRulesOf(snapshot, parent.id).map((entry) => entry.id),
      [first.id]
    );
    assert.deepStrictEqual(validateSnapshot(snapshot), []);
  });

  it("validates the form profile and target lineage and tracks all referenced IDs", () => {
    const valid = rule("conditional", {
      condition: { arg: { path: [title.id] }, op: "changed" },
    });

    assert.deepStrictEqual(validateSnapshot(base.with(KEY, [valid])), []);
    const refs = dependenciesOf(valid).map((entry) => entry.toId);
    assert.include(refs, parent.id);
    assert.include(refs, title.id);
    assert.include(
      validateSnapshot(
        base.with(KEY, [rule("wrong_field", { fieldId: other.id })])
      ).map((entry) => entry.code),
      "invalidFormRule"
    );

    const quantifier = rule("outside_profile", {
      condition: { class: child.id, op: "partsChanged" },
    });

    assert.include(
      validateSnapshot(base.with(KEY, [quantifier])).map((entry) => entry.code),
      "invalidCondition"
    );
  });

  it("renames a referenced field without changing the rule, and exposes the documented local overrides", () => {
    const shipped = rule("shipped", {
      condition: { arg: { path: [title.id] }, op: "notEmpty" },
      owner: { layer: "app", setId: freshId() },
    });

    const snapshot = base.with(KEY, [shipped]);

    const renamed = applyOperations(
      snapshot,
      [{ id: title.id, name: "renamed", op: "rename", version: 1 }],
      { ...KEY, revision: 2 }
    );

    assert.isTrue(Result.isSuccess(renamed));

    if (Result.isSuccess(renamed)) {
      assert.deepStrictEqual(renamed.success.after.get(shipped.id), shipped);
    }

    assert.deepStrictEqual(overridableProperties(shipped), [
      "active",
      "clearHidden",
      "condition",
      "message",
      "order",
      "value",
    ]);
  });
});
