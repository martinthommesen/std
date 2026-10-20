import { assert, describe, it } from "@effect/vitest";
import type { ConditionProfile } from "@std/values/field-type";

import type { Expr, Path, Value } from "../src/ast.ts";
import { checkCondition, checkConditionJson } from "../src/check.ts";
import type { CheckOptions } from "../src/check.ts";
import type { IssueReason } from "../src/issue.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  LAPTOP,
  LAPTOP_FIELDS as L,
  PERSON_FIELDS as P,
  RETIRED_FIELD,
} from "./support/schema.ts";

const path = (...fields: readonly { readonly id: string }[]): Path => ({
  path: fields.map((field) => field.id),
});

const options = (
  profile: ConditionProfile,
  extra: Partial<CheckOptions> = {}
): CheckOptions => ({
  classId: ASSET,
  profile,
  purpose: "store",
  view: fixtureView,
  ...extra,
});

const reasons = (
  expr: Expr,
  profile: ConditionProfile = "filter",
  extra: Partial<CheckOptions> = {}
): IssueReason[] => {
  const result = checkCondition(expr, options(profile, extra));

  return result.ok ? [] : result.error.issues.map((found) => found.reason);
};

const list = (size: number): Expr => ({
  left: path(A.count),
  op: "in",
  right: Array.from({ length: size }, (_, index): Value => ({
    value: index,
  })),
});

describe("checker", () => {
  it("accepts a condition over every hop the filter profile allows", () => {
    const expr: Expr = {
      args: [
        { left: path(A.cost), op: "gt", right: { value: "0" } },
        { left: path(A.status), op: "eq", right: { value: "lost" } },
        { left: path(A.owner, P.name), op: "eq", right: { value: "X" } },
        { left: path(A.owner), op: "eq", right: { ctx: "me" } },
        {
          left: path(A.due),
          op: "lt",
          right: { offset: -7, rel: "today", unit: "day" },
        },
        {
          left: path(A.opened),
          op: "inPeriod",
          period: { offset: 0, unit: "week" },
        },
        { left: path(A.name), op: "contains", right: "a" },
        { arg: path(A.owner), op: "empty" },
        {
          left: path(A.status),
          op: "in",
          right: [{ value: "a" }, { value: "b" }],
        },
      ],
      op: "and",
    };

    assert.deepStrictEqual(reasons(expr), []);
  });

  it("reports unknown fields, child-only fields and unreadable fields alike", () => {
    assert.deepStrictEqual(
      reasons({
        arg: { path: ["00000000-0000-7000-8000-00000000ffff"] },
        op: "empty",
      }),
      ["unknownField"]
    );
    assert.deepStrictEqual(reasons({ arg: path(L.ram), op: "empty" }), [
      "unknownField",
    ]);
    assert.deepStrictEqual(
      reasons({ arg: path(L.ram), op: "empty" }, "filter", { classId: LAPTOP }),
      []
    );

    const hidden = {
      ...fixtureView,
      canRead: (_classId: string, fieldId: string) => fieldId !== A.cost.id,
    };

    assert.deepStrictEqual(
      reasons({ arg: path(A.cost), op: "empty" }, "filter", { view: hidden }),
      ["unknownField"]
    );
  });

  it("refuses retired fields only when a condition is stored", () => {
    const expr: Expr = { arg: path(RETIRED_FIELD), op: "empty" };

    assert.deepStrictEqual(reasons(expr), ["retiredField"]);
    assert.deepStrictEqual(
      reasons(expr, "filter", { purpose: "evaluate" }),
      []
    );
  });

  it("limits path hops per profile", () => {
    const oneHop: Expr = { arg: path(A.owner, P.name), op: "empty" };

    const threeHops: Expr = {
      arg: path(A.owner, P.manager, P.manager, P.name),
      op: "empty",
    };

    assert.deepStrictEqual(reasons(oneHop, "filter"), []);
    assert.deepStrictEqual(reasons(oneHop, "accessRule"), ["tooManyHops"]);
    assert.deepStrictEqual(
      reasons(oneHop, "accessRule", { profileOptions: { accessRuleHops: 1 } }),
      []
    );
    assert.deepStrictEqual(reasons(oneHop, "subscription"), ["tooManyHops"]);
    assert.deepStrictEqual(reasons(threeHops, "recordRule"), []);
    assert.deepStrictEqual(reasons(threeHops, "filter"), ["tooManyHops"]);
    assert.deepStrictEqual(
      reasons(oneHop, "formRule", { isPreloaded: () => false }),
      ["pathNotPreloaded"]
    );
    assert.deepStrictEqual(
      reasons({ arg: path(A.name, P.name), op: "empty" }),
      ["notAReference"]
    );
  });

  it("allows previous and changed only in form and record rules", () => {
    const previous: Expr = {
      arg: { image: "previous", path: [A.status.id] },
      op: "empty",
    };

    const changed: Expr = { arg: path(A.status), op: "changed" };

    for (const profile of ["filter", "accessRule", "subscription"] as const) {
      assert.deepStrictEqual(reasons(previous, profile), [
        "previousNotAllowed",
      ]);
      assert.deepStrictEqual(reasons(changed, profile), ["operatorNotAllowed"]);
    }

    for (const profile of ["formRule", "recordRule"] as const) {
      assert.deepStrictEqual(reasons(previous, profile), []);
      assert.deepStrictEqual(reasons(changed, profile), []);
    }
  });

  it("checks context values per profile and type", () => {
    const me: Expr = { left: path(A.owner), op: "eq", right: { ctx: "me" } };

    const groups: Expr = {
      left: path(A.owner),
      op: "in",
      right: { ctx: "myGroups" },
    };

    assert.deepStrictEqual(reasons(me, "subscription"), ["contextNotAllowed"]);
    assert.deepStrictEqual(reasons(groups, "filter"), ["contextNotAllowed"]);
    assert.deepStrictEqual(
      reasons(groups, "filter", { profileOptions: { myGroups: true } }),
      []
    );
    assert.deepStrictEqual(
      reasons(groups, "formRule", { profileOptions: { myGroups: true } }),
      ["contextNotAllowed"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "eq", right: { ctx: "me" } }),
      ["contextNotForType"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.due), op: "lt", right: { ctx: "now" } }),
      ["contextNotForType"]
    );
    assert.deepStrictEqual(
      reasons({
        left: path(A.due),
        op: "lt",
        right: { offset: 1, rel: "now", unit: "hour" },
      }),
      ["contextNotForType"]
    );
    assert.deepStrictEqual(
      reasons({
        left: path(A.opened),
        op: "lt",
        right: { offset: 100_001, rel: "now", unit: "hour" },
      }),
      ["offsetOutOfRange"]
    );
  });

  it("checks operators against field types", () => {
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "lt", right: { value: "a" } }),
      ["operatorNotForType"]
    );
    assert.deepStrictEqual(reasons({ arg: path(A.active), op: "empty" }), [
      "operatorNotForType",
    ]);
    assert.deepStrictEqual(
      reasons({ left: path(A.cost), op: "contains", right: "1" }),
      ["operatorNotForType"]
    );

    const secret = checkCondition(
      { left: path(A.key), op: "eq", right: { value: "x" } },
      options("filter")
    );

    assert.isFalse(secret.ok);
    assert.strictEqual(
      secret.ok ? undefined : secret.error.issues[0]?.hint,
      "Password and secret fields allow only empty and notEmpty."
    );
    assert.deepStrictEqual(reasons({ arg: path(A.key), op: "notEmpty" }), []);
    assert.deepStrictEqual(reasons({ arg: path(A.token), op: "empty" }), []);
    assert.deepStrictEqual(
      reasons({ arg: path(A.key), op: "changed" }, "recordRule"),
      ["operatorNotForType"]
    );
    assert.deepStrictEqual(
      reasons({ arg: path(A.data), op: "changed" }, "recordRule"),
      []
    );
  });

  it("allows second paths only within one comparison class", () => {
    assert.deepStrictEqual(
      reasons({ left: path(A.count), op: "lt", right: path(A.cost) }),
      []
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "eq", right: path(A.transcript) }),
      []
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.owner), op: "eq", right: path(A.external) }),
      []
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.due), op: "eq", right: path(A.opened) }),
      ["comparisonClassMismatch"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "eq", right: path(A.status) }),
      ["comparisonClassMismatch"]
    );
  });

  it("converts literals under the type's rules, not the field's settings", () => {
    assert.deepStrictEqual(
      reasons({ left: path(A.cost), op: "eq", right: { value: "1.0000001" } }),
      []
    );
    assert.deepStrictEqual(
      reasons({
        left: path(A.count),
        op: "eq",
        right: { value: 2_147_483_648 },
      }),
      ["invalidLiteral"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.cost), op: "eq", right: { value: 1 } }),
      ["invalidLiteral"]
    );
    assert.deepStrictEqual(
      reasons({
        left: path(A.opened),
        op: "eq",
        right: { value: "2026-10-20T10:00:60Z" },
      }),
      ["invalidLiteral"]
    );
  });

  it("refuses a text literal that converts to empty, with a hint", () => {
    const result = checkCondition(
      { left: path(A.name), op: "eq", right: { value: "   " } },
      options("filter")
    );

    assert.isFalse(result.ok);
    const [found] = result.ok ? [] : result.error.issues;
    assert.strictEqual(found?.reason, "emptyLiteral");
    assert.deepStrictEqual(found?.path, ["right", "value"]);
    assert.include(found?.hint ?? "", "empty");
  });

  it("refuses an empty contains needle but not an empty prefix", () => {
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "contains", right: "" }),
      ["emptyNeedle"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "notContains", right: "" }),
      ["emptyNeedle"]
    );
    assert.deepStrictEqual(
      reasons({ left: path(A.name), op: "startsWith", right: "" }),
      []
    );
  });

  it("limits in lists to 1,000 elements", () => {
    assert.deepStrictEqual(reasons(list(1000)), []);
    assert.deepStrictEqual(reasons(list(1001)), ["tooManyElements"]);
    assert.deepStrictEqual(reasons(list(0)), []);
  });

  it("reports every issue with its path into the AST", () => {
    const result = checkCondition(
      {
        args: [
          { arg: path(A.active), op: "empty" },
          {
            args: [{ left: path(A.name), op: "contains", right: "" }],
            op: "or",
          },
        ],
        op: "and",
      },
      options("filter")
    );

    assert.isFalse(result.ok);
    assert.deepStrictEqual(
      result.ok ? [] : result.error.issues.map((found) => found.path),
      [
        ["args", 0, "op"],
        ["args", 1, "args", 0, "right"],
      ]
    );
  });

  it("decodes the JSON form strictly", () => {
    const good = checkConditionJson(
      { arg: { path: [A.name.id] }, op: "empty" },
      options("filter")
    );

    const extraKey = checkConditionJson(
      { arg: { path: [A.name.id] }, extra: 1, op: "empty" },
      options("filter")
    );

    const myGroupsInEq = checkConditionJson(
      { left: { path: [A.owner.id] }, op: "eq", right: { ctx: "myGroups" } },
      options("filter")
    );

    assert.isTrue(good.ok);
    assert.isFalse(extraKey.ok);
    assert.isFalse(myGroupsInEq.ok);
  });
});
