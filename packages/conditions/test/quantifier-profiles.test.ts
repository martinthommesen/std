/**
 * `quantifier-profiles` (Contracts 5.10), at the checker: `anyPart`,
 * `allParts`, `partsChanged` and an `owner.` path are refused at check
 * time, with a typed issue naming the operator, in every profile; only the
 * aggregate checker (`checkAggregateCondition`) accepts them. The
 * definition-level cases (a `before`, `after` or `afterCommit` record rule
 * against an `aggregate` one) are in the server's `record-rule-actions`.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  checkAggregateCondition,
  checkPartCondition,
  resolvePartCondition,
} from "../src/aggregate.ts";
import type { Expr } from "../src/ast.ts";
import { evaluateInBrowser } from "../src/browser.ts";
import { checkCondition } from "../src/check.ts";
import { staticClassView } from "../src/class-view.ts";
import type { FieldInfo } from "../src/class-view.ts";
import { ConditionDefectError } from "../src/defect.ts";
import { evaluateCondition } from "../src/evaluate.ts";
import { PROFILES } from "../src/profile.ts";
import { compileCondition } from "../src/sql.ts";
import { makeResolved } from "../src/typed.ts";
import { identHooks, issueReasons } from "./support/schema.ts";

const OWNER = "0e000000-0000-4000-8000-000000000001";
const PART = "0e000000-0000-4000-8000-000000000002";

const NUM: FieldInfo = {
  classId: OWNER,
  id: "0e000000-0000-4000-8000-0000000000a1",
  name: "num",
  retired: false,
  type: { kind: "integer" },
};

const PART_NUM: FieldInfo = {
  classId: PART,
  id: "0e000000-0000-4000-8000-0000000000b1",
  name: "part_num",
  retired: false,
  type: { kind: "integer" },
};

const OWNER_REF: FieldInfo = {
  classId: PART,
  id: "0e000000-0000-4000-8000-0000000000b0",
  name: "owner",
  retired: false,
  type: { aggregate: true, kind: "reference", targetClassId: OWNER },
};

const view = staticClassView([
  { fields: [NUM], id: OWNER, parentId: null },
  { fields: [PART_NUM, OWNER_REF], id: PART, parentId: null },
]);

const where: Expr = {
  left: { path: [PART_NUM.id] },
  op: "eq",
  right: { path: [NUM.id], scope: "owner" },
};

const QUANTIFIED: readonly (readonly [string, Expr])[] = [
  ["anyPart", { class: PART, op: "anyPart", where }],
  ["allParts", { class: PART, op: "allParts", where }],
  ["partsChanged", { class: PART, op: "partsChanged" }],
];

describe("quantifier-profiles", () => {
  it("every profile refuses anyPart, allParts and partsChanged, naming the operator", () => {
    for (const profile of PROFILES) {
      for (const [operator, expr] of QUANTIFIED) {
        const checked = checkCondition(
          { args: [expr], op: "and" },
          { classId: OWNER, profile, purpose: "store", view }
        );

        assert.isFalse(checked.ok, `${operator} in ${profile}`);

        const issues = checked.ok ? [] : checked.error.issues;

        assert.deepStrictEqual(
          issues.map((found) => [found.reason, found.path.join(".")]),
          [["operatorNotAllowed", "args.0.op"]]
        );
        assert.include(issues[0]?.message ?? "", operator);
      }
    }
  });

  it("every profile refuses an owner path", () => {
    for (const profile of PROFILES) {
      const checked = checkCondition(
        { arg: { path: [NUM.id], scope: "owner" }, op: "empty" },
        { classId: OWNER, profile, purpose: "store", view }
      );

      assert.deepStrictEqual(
        issueReasons(checked),
        ["scopeNotAllowed"],
        profile
      );
    }
  });

  it("the aggregate checker accepts them on the owner's part classes", () => {
    for (const [operator, expr] of QUANTIFIED) {
      const checked = checkAggregateCondition(
        { args: [expr, { arg: expr, op: "not" }], op: "or" },
        {
          classId: OWNER,
          isPartClass: (classId) => classId === PART,
          purpose: "store",
          view,
        }
      );

      assert.isTrue(checked.ok, operator);
    }
  });

  it("a part condition's owner paths never reach the SQL compiler or the plain evaluator", () => {
    const checked = checkPartCondition(
      {
        left: { path: [NUM.id], scope: "owner" },
        op: "eq",
        right: { value: 1 },
      },
      PART,
      OWNER,
      { purpose: "evaluate", view }
    );

    assert.isTrue(checked.ok);

    if (!checked.ok) {
      return;
    }

    // Its own stage: not a CheckedCondition, so not a compiler input.
    assert.strictEqual(checked.value.stage, "checkedPart");

    const resolved = resolvePartCondition(checked.value, {
      now: 0,
      timeZone: "UTC",
    });

    assert.isTrue(resolved.ok);

    if (!resolved.ok) {
      return;
    }

    // Even a tree taken out of it is refused, never compiled as the
    // part's own field.
    const smuggled = makeResolved(PART, resolved.value.root);

    assert.throws(() => {
      compileCondition(smuggled, {
        alias: "p",
        hooks: identHooks,
      });
    }, ConditionDefectError);
    assert.throws(() => {
      evaluateCondition(smuggled, { record: { [PART_NUM.id]: 1 } });
    }, ConditionDefectError);
    // Nor the browser's evaluator, which would read the owner's field from
    // the part's image.
    assert.throws(() => {
      evaluateInBrowser(smuggled, {
        record: { [NUM.id]: 1, [PART_NUM.id]: 1 },
      });
    }, ConditionDefectError);
  });
});
