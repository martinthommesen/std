import { assert, describe, it } from "@effect/vitest";
import type { ConditionProfile } from "@std/values/field-type";
import {
  assert as check,
  constantFrom,
  integer,
  property,
  string,
  tuple,
} from "fast-check";

import type { Expr } from "../src/ast.ts";
import { checkCondition } from "../src/check.ts";
import { InvalidCondition } from "../src/issue.ts";
import { PROFILES } from "../src/profile.ts";
import { locateIssues, parseCondition } from "../src/syntax-parse.ts";
import { printCondition } from "../src/syntax-print.ts";
import { exprArb } from "./support/generate.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  LAPTOP,
  LAPTOP_FIELDS as L,
  PERSON_FIELDS as P,
} from "./support/schema.ts";

const resolveName = (classId: string, name: string) =>
  fixtureView.fieldByName?.(classId, name);

const parse = (text: string, classId = ASSET) =>
  parseCondition(text, { classId, resolveName });

const parsed = (text: string, classId = ASSET): Expr => {
  const result = parse(text, classId);

  if (!result.ok) {
    throw result.error;
  }

  return result.value.expr;
};

const print = (expr: Expr, classId = ASSET): string => {
  const result = printCondition(expr, { classId, field: fixtureView.field });

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
};

const reasonAt = (text: string) => {
  const result = parse(text);

  return result.ok ? undefined : result.error.issues[0];
};

describe("text syntax", () => {
  it("parses the documented examples", () => {
    assert.deepStrictEqual(parsed('cost > 0 and status = "lost"'), {
      args: [
        { left: { path: [A.cost.id] }, op: "gt", right: { value: "0" } },
        { left: { path: [A.status.id] }, op: "eq", right: { value: "lost" } },
      ],
      op: "and",
    });
    assert.deepStrictEqual(parsed('docked.name = "X"', LAPTOP), {
      left: { path: [L.docked.id, P.name.id] },
      op: "eq",
      right: { value: "X" },
    });
    assert.deepStrictEqual(parsed("owner = me"), {
      left: { path: [A.owner.id] },
      op: "eq",
      right: { ctx: "me" },
    });
    assert.deepStrictEqual(parsed("due < today - 7 days"), {
      left: { path: [A.due.id] },
      op: "lt",
      right: { offset: -7, rel: "today", unit: "day" },
    });
    assert.deepStrictEqual(parsed("opened in this week"), {
      left: { path: [A.opened.id] },
      op: "inPeriod",
      period: { offset: 0, unit: "week" },
    });
    assert.deepStrictEqual(parsed("opened in quarter -2"), {
      left: { path: [A.opened.id] },
      op: "inPeriod",
      period: { offset: -2, unit: "quarter" },
    });
    assert.deepStrictEqual(parsed('name contains "a"'), {
      left: { path: [A.name.id] },
      op: "contains",
      right: "a",
    });
    assert.deepStrictEqual(parsed("owner is empty"), {
      arg: { path: [A.owner.id] },
      op: "empty",
    });
    assert.deepStrictEqual(parsed('status in ("a", "b")'), {
      left: { path: [A.status.id] },
      op: "in",
      right: [{ value: "a" }, { value: "b" }],
    });
    assert.deepStrictEqual(parsed("not (active = true or count >= -5)"), {
      arg: {
        args: [
          { left: { path: [A.active.id] }, op: "eq", right: { value: true } },
          { left: { path: [A.count.id] }, op: "ge", right: { value: -5 } },
        ],
        op: "or",
      },
      op: "not",
    });
    assert.deepStrictEqual(parsed("previous.status != status"), {
      left: { image: "previous", path: [A.status.id] },
      op: "ne",
      right: { path: [A.status.id] },
    });
    assert.deepStrictEqual(parsed("changed(status)"), {
      arg: { path: [A.status.id] },
      op: "changed",
    });
    assert.deepStrictEqual(parsed("opened > now - 90 minutes"), {
      left: { path: [A.opened.id] },
      op: "gt",
      right: { offset: -90, rel: "now", unit: "minute" },
    });
    assert.deepStrictEqual(parsed("all()"), { args: [], op: "and" });
    assert.deepStrictEqual(parsed("owner not in myGroups"), {
      left: { path: [A.owner.id] },
      op: "notIn",
      right: { ctx: "myGroups" },
    });
    assert.deepStrictEqual(
      parsed('serial = 9007199254740993 and name starts with "x"'),
      {
        args: [
          {
            left: { path: [A.serial.id] },
            op: "eq",
            right: { value: "9007199254740993" },
          },
          { left: { path: [A.name.id] }, op: "startsWith", right: "x" },
        ],
        op: "and",
      }
    );
  });

  it("prints names back, quoting keywords and keeping nesting", () => {
    assert.strictEqual(
      print({
        args: [
          {
            args: [
              { op: "true" },
              { arg: { path: [A.name.id] }, op: "notEmpty" },
            ],
            op: "and",
          },
          { args: [], op: "or" },
          { args: [{ op: "false" }], op: "and" },
        ],
        op: "and",
      }),
      "(true and name is not empty) and any() and all(false)"
    );
    assert.strictEqual(
      print({
        left: { path: [A.name.id] },
        op: "eq",
        right: {
          value: `say "hi"
${String.fromCodePoint(0x20_28)}`,
        },
      }),
      String.raw`name = "say \"hi\"\n\u{2028}"`
    );
  });

  it("round-trips every checked condition: parse(print(a)) = a", () => {
    const cases = tuple(
      constantFrom(...PROFILES),
      constantFrom(ASSET, LAPTOP)
    ).chain(([profile, classId]) =>
      exprArb({
        classId,
        depth: 6,
        profile,
        profileOptions: { accessRuleHops: 1, myGroups: true },
      }).map((expr) => ({ classId, expr, profile }))
    );

    let checked = 0;

    check(
      property(
        cases,
        ({
          classId,
          expr,
          profile,
        }: {
          classId: string;
          expr: Expr;
          profile: ConditionProfile;
        }) => {
          const result = checkCondition(expr, {
            classId,
            profile,
            profileOptions: { accessRuleHops: 1, myGroups: true },
            purpose: "store",
            view: fixtureView,
          });

          if (!result.ok) {
            return;
          }

          checked += 1;
          assert.deepStrictEqual(parsed(print(expr, classId), classId), expr);
        }
      ),
      { numRuns: 2000, seed: 61 }
    );

    assert.isAbove(checked, 1000);
  });

  it("reports typed errors with positions, never throwing, on fuzzed input", () => {
    const fragments = [
      "name",
      "=",
      '"x"',
      "(",
      ")",
      "and",
      "or",
      "not",
      "in",
      "is",
      "empty",
      "previous",
      ".",
      "owner",
      "name",
      "-",
      "7",
      "days",
      "today",
      "now",
      "me",
      "myGroups",
      "this",
      "week",
      ",",
      "`",
      "\\",
      '"',
      "contains",
      "changed",
      "all",
      "any",
      "1.5",
      "true",
      "<=",
      "!=",
      ">",
      "starts",
      "with",
      "docked",
      "\u0000",
      "😀",
    ];

    const fuzz = tuple(
      integer({ max: 12, min: 0 }).chain((size) =>
        tuple(...Array.from({ length: size }, () => constantFrom(...fragments)))
      ),
      string({ maxLength: 20, unit: "binary" })
    );

    check(
      property(fuzz, ([parts, noise]) => {
        for (const text of [
          parts.join(" "),
          parts.join(""),
          noise,
          `${parts.join(" ")}${noise}`,
        ]) {
          const result = parse(text);

          if (!result.ok) {
            assert.instanceOf(result.error, InvalidCondition);
            const [found] = result.error.issues;
            assert.isDefined(found?.span);
            assert.isAtMost(found?.span?.end ?? 0, text.length);
          }
        }
      }),
      { numRuns: 3000, seed: 62 }
    );
  });

  it("gives specific errors for names, literals and myGroups", () => {
    assert.deepStrictEqual(
      [reasonAt("nmae = 1")?.reason, reasonAt("nmae = 1")?.span],
      ["unknownField", { end: 4, start: 0 }]
    );
    assert.strictEqual(reasonAt('count = "1"')?.reason, "invalidLiteral");
    assert.strictEqual(
      reasonAt("count = 2147483648")?.reason,
      "invalidLiteral"
    );
    assert.strictEqual(
      reasonAt("owner = myGroups")?.reason,
      "myGroupsOnlyInIn"
    );
    assert.strictEqual(reasonAt("name.x = 1")?.reason, "notAReference");
    assert.strictEqual(reasonAt("ram = 1")?.reason, "unknownField");
    assert.strictEqual(reasonAt('name = "x')?.reason, "syntax");
    assert.strictEqual(reasonAt("name = ")?.reason, "syntax");
  });

  it("locates checker issues in the source text", () => {
    const text = 'status = "open" and name = "   "';
    const result = parse(text);
    assert.isTrue(result.ok);

    if (!result.ok) {
      return;
    }

    const checked = checkCondition(result.value.expr, {
      classId: ASSET,
      profile: "filter",
      purpose: "store",
      view: fixtureView,
    });

    assert.isFalse(checked.ok);

    if (!checked.ok) {
      const [found] = locateIssues(checked.error.issues, result.value.spans);
      assert.strictEqual(found?.reason, "emptyLiteral");
      assert.strictEqual(
        text.slice(found?.span?.start, found?.span?.end),
        '"   "'
      );
    }
  });
});
