import { assert, describe, it } from "@effect/vitest";
import { parseDecimal } from "@std/values/decimal";
import { getOrThrow } from "@std/values/field-error";
import type { ConditionProfile } from "@std/values/field-type";
import {
  assert as check,
  constantFrom,
  property,
  record as recordOf,
  subarray,
  tuple,
} from "fast-check";

import type { Expr, Path } from "../src/ast.ts";
import { evaluateInBrowser } from "../src/browser.ts";
import { checkCondition } from "../src/check.ts";
import { ConditionDefectError } from "../src/defect.ts";
import type { ImageSource, RecordImage } from "../src/evaluate-core.ts";
import { evaluateCondition } from "../src/evaluate.ts";
import { negationNormalForm } from "../src/nnf.ts";
import type { NnfNode } from "../src/nnf.ts";
import { resolveCondition } from "../src/resolve.ts";
import type { ConditionContext } from "../src/resolve.ts";
import { simplifyForCaller } from "../src/simplify.ts";
import { makeResolved } from "../src/typed.ts";
import type { ResolvedCondition } from "../src/typed.ts";
import { assetRowsArb, exprArb, personRowsArb } from "./support/generate.ts";
import { sourceFor } from "./support/images.ts";
import { PERSON_IDS, UUID_POOL } from "./support/pools.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  LAPTOP,
  PERSON_FIELDS as P,
} from "./support/schema.ts";

const CONTEXT: ConditionContext = {
  me: PERSON_IDS[0] ?? "",
  myGroups: PERSON_IDS.slice(0, 2),
  now: Date.UTC(2026, 9, 25, 9, 30),
  timeZone: "Europe/Berlin",
};

const path = (...fields: readonly { readonly id: string }[]): Path => ({
  path: fields.map((field) => field.id),
});

const prepare = (
  expr: Expr,
  profile: ConditionProfile = "recordRule",
  classId = ASSET,
  context: ConditionContext = CONTEXT
): ResolvedCondition => {
  const checked = checkCondition(expr, {
    classId,
    profile,
    profileOptions: { accessRuleHops: 1, myGroups: true },
    purpose: "evaluate",
    view: fixtureView,
  });

  if (!checked.ok) {
    throw checked.error;
  }

  const resolved = resolveCondition(checked.value, context);

  if (!resolved.ok) {
    throw resolved.error;
  }

  return resolved.value;
};

const FULL: RecordImage = Object.fromEntries(
  Object.values(A).map((field) => [field.id, null])
);

const image = (values: RecordImage): RecordImage => ({ ...FULL, ...values });

const run = (expr: Expr, source: ImageSource): boolean =>
  evaluateCondition(prepare(expr), source);

describe("TypeScript evaluator", () => {
  it("treats null as empty: ne and not-lt hold for an empty field", () => {
    const record = image({});

    assert.isTrue(
      run(
        { left: path(A.status), op: "ne", right: { value: "closed" } },
        { record }
      )
    );
    assert.isTrue(
      run(
        {
          arg: {
            left: path(A.due),
            op: "lt",
            right: { offset: 0, rel: "today", unit: "day" },
          },
          op: "not",
        },
        { record }
      )
    );
    assert.isFalse(
      run(
        {
          left: path(A.due),
          op: "lt",
          right: { offset: 0, rel: "today", unit: "day" },
        },
        { record }
      )
    );
    assert.isTrue(
      run({ left: path(A.name), op: "eq", right: path(A.code) }, { record })
    );
    assert.isFalse(
      run({ left: path(A.count), op: "le", right: path(A.cost) }, { record })
    );
  });

  it("compares text by key: STRASSE matches Straße, i does not match İ", () => {
    const record = image({ [A.name.id]: "Straße", [A.code.id]: "İ" });

    assert.isTrue(
      run(
        { left: path(A.name), op: "eq", right: { value: "STRASSE" } },
        { record }
      )
    );
    assert.isFalse(
      run({ left: path(A.code), op: "eq", right: { value: "i" } }, { record })
    );
    assert.isFalse(
      run(
        { left: path(A.name), op: "eq", right: { value: "i" } },
        { record: image({ [A.name.id]: "İ" }) }
      )
    );
    assert.isTrue(
      run({ left: path(A.name), op: "contains", right: "SS" }, { record })
    );
  });

  it("compares numbers exactly across the numeric class", () => {
    const record = image({
      [A.cost.id]: getOrThrow(parseDecimal("1.500000")),
      [A.count.id]: 1,
      [A.serial.id]: 9_007_199_254_740_993n,
    });

    assert.isTrue(
      run({ left: path(A.cost), op: "eq", right: { value: "1.5" } }, { record })
    );
    assert.isTrue(
      run({ left: path(A.count), op: "lt", right: path(A.cost) }, { record })
    );
    assert.isTrue(
      run(
        {
          left: path(A.serial),
          op: "gt",
          right: { value: "9007199254740992" },
        },
        { record }
      )
    );
    assert.isFalse(
      run({ left: path(A.count), op: "in", right: [] }, { record })
    );
    assert.isTrue(
      run({ left: path(A.count), op: "notIn", right: [] }, { record })
    );
  });

  it("evaluates changed: notEmpty on create, false on delete", () => {
    const record = image({ [A.status.id]: "open", [A.active.id]: false });
    const changed: Expr = { arg: path(A.status), op: "changed" };
    const empty: Expr = { arg: path(A.name), op: "changed" };

    assert.isTrue(run(changed, { previous: null, record }));
    assert.isFalse(run(empty, { previous: null, record }));
    assert.isTrue(
      run({ arg: path(A.active), op: "changed" }, { previous: null, record })
    );
    assert.isFalse(run(changed, { previous: record, record }));
    assert.isTrue(
      run(changed, { previous: image({ [A.status.id]: "closed" }), record })
    );
    assert.isTrue(
      run(
        { arg: path(A.name), op: "changed" },
        {
          previous: image({ [A.name.id]: "alice" }),
          record: image({ [A.name.id]: "Alice" }),
        }
      )
    );
  });

  it("follows references; a hidden target behaves like an empty reference", () => {
    const owner = PERSON_IDS[1] ?? "";
    const record = image({ [A.owner.id]: owner });

    const person: RecordImage = Object.fromEntries(
      Object.values(P).map((field) => [
        field.id,
        field === P.name ? "Ann" : null,
      ])
    );

    const named: Expr = {
      left: path(A.owner, P.name),
      op: "eq",
      right: { value: "ann" },
    };

    assert.isTrue(run(named, { record, targets: new Map([[owner, person]]) }));
    assert.isFalse(run(named, { record, targets: new Map([[owner, null]]) }));
    assert.isTrue(
      run(
        { arg: path(A.owner, P.name), op: "empty" },
        { record, targets: new Map([[owner, null]]) }
      )
    );
    assert.isTrue(
      run(
        { left: path(A.owner), op: "eq", right: { ctx: "me" } },
        { record: image({ [A.owner.id]: PERSON_IDS[0] ?? "" }) }
      )
    );
    assert.isTrue(
      evaluateCondition(
        prepare(
          { left: path(A.owner), op: "in", right: { ctx: "myGroups" } },
          "filter"
        ),
        { record }
      )
    );
  });

  it("treats a missing field or target as a defect, never as false", () => {
    const owner = PERSON_IDS[1] ?? "";

    assert.throws(() => {
      run({ arg: path(A.name), op: "empty" }, { record: {} });
    }, ConditionDefectError);
    assert.throws(() => {
      run(
        { arg: path(A.owner, P.name), op: "empty" },
        { record: image({ [A.owner.id]: owner }) }
      );
    }, ConditionDefectError);
    assert.throws(() => {
      run({ arg: path(A.name), op: "changed" }, { record: FULL });
    }, ConditionDefectError);
    assert.throws(() => {
      evaluateCondition(
        prepare(
          { left: path(A.owner), op: "eq", right: { ctx: "me" } },
          "filter",
          ASSET,
          {
            now: 0,
            timeZone: "UTC",
          }
        ),
        { record: FULL }
      );
    }, ConditionDefectError);
  });
});

const browser = (expr: Expr, record: RecordImage, context = CONTEXT) =>
  evaluateInBrowser(prepare(expr, "formRule", ASSET, context), { record });

describe("browser evaluator", () => {
  it("returns Unknown for missing fields, with Kleene connectives", () => {
    const known: Expr = {
      left: path(A.status),
      op: "eq",
      right: { value: "open" },
    };

    const missing: Expr = { arg: path(A.name), op: "empty" };
    const record: RecordImage = { [A.status.id]: "closed" };

    assert.strictEqual(browser(missing, record), "unknown");
    assert.strictEqual(
      browser({ args: [known, missing], op: "and" }, record),
      false
    );
    assert.strictEqual(
      browser({ args: [{ arg: known, op: "not" }, missing], op: "or" }, record),
      true
    );
    assert.strictEqual(browser({ arg: missing, op: "not" }, record), "unknown");
    assert.strictEqual(
      browser(
        { left: path(A.owner), op: "eq", right: { ctx: "me" } },
        { [A.owner.id]: null },
        {
          now: 0,
          timeZone: "UTC",
        }
      ),
      false
    );
    assert.strictEqual(
      browser(
        { left: path(A.owner), op: "eq", right: { ctx: "me" } },
        { [A.owner.id]: PERSON_IDS[0] ?? "" },
        {
          now: 0,
          timeZone: "UTC",
        }
      ),
      "unknown"
    );
  });

  it("returns Unknown for an undelivered target and for unassigned code points", () => {
    const owner = PERSON_IDS[2] ?? "";

    assert.strictEqual(
      evaluateInBrowser(
        prepare({ arg: path(A.owner, P.name), op: "empty" }, "formRule"),
        {
          record: { [A.owner.id]: owner },
          targets: new Map(),
        }
      ),
      "unknown"
    );
    // U+0378 is unassigned in Unicode 16.0.0.
    assert.strictEqual(
      browser({ arg: path(A.name), op: "empty" }, { [A.name.id]: "a͸" }),
      "unknown"
    );
  });

  it("applies the write conversion to proposed text first", () => {
    const strasse: Expr = {
      left: path(A.name),
      op: "eq",
      right: { value: "strasse" },
    };

    assert.strictEqual(browser(strasse, { [A.name.id]: "  Straße \t" }), true);
    assert.strictEqual(
      browser({ arg: path(A.name), op: "empty" }, { [A.name.id]: "   " }),
      true
    );
    assert.strictEqual(
      browser(
        { left: path(A.name), op: "eq", right: { value: "é" } },
        { [A.name.id]: "é" }
      ),
      true
    );
    assert.strictEqual(
      browser(
        { left: path(A.notes), op: "eq", right: { value: "a\nb" } },
        { [A.notes.id]: "a\r\nb" }
      ),
      true
    );
    assert.strictEqual(
      browser({ arg: path(A.name), op: "empty" }, { [A.name.id]: "a\nb" }),
      "unknown"
    );
  });

  it("is sound: with data removed it agrees with the full result or is Unknown", () => {
    const allIds = [
      ...Object.values(A).map((field) => field.id),
      ...PERSON_IDS,
    ];

    check(
      property(
        recordOf({
          dropped: subarray(allIds),
          expr: exprArb({ classId: ASSET, depth: 4, profile: "formRule" }),
          people: personRowsArb,
          rows: assetRowsArb(1),
        }),
        ({ dropped, expr, people, rows }) => {
          const [row] = rows;

          const checked = checkCondition(expr, {
            classId: ASSET,
            profile: "formRule",
            purpose: "evaluate",
            view: fixtureView,
          });

          if (row === undefined || row.classId !== ASSET || !checked.ok) {
            return;
          }

          const resolved = resolveCondition(checked.value, CONTEXT);

          if (!resolved.ok) {
            return;
          }

          const full = sourceFor(row, people);
          const gone = new Set(dropped);

          const strip = (values: RecordImage): RecordImage =>
            Object.fromEntries(
              Object.entries(values).filter(([id]) => !gone.has(id))
            );

          const partial: ImageSource = {
            previous:
              full.previous === null || full.previous === undefined
                ? null
                : strip(full.previous),
            record: strip(full.record),
            targets: new Map(
              [
                ...(full.targets ?? new Map<string, RecordImage | null>()),
              ].filter(([id]) => !gone.has(id))
            ),
          };

          const expected = evaluateCondition(resolved.value, full);
          const verdict = evaluateInBrowser(resolved.value, partial);

          if (verdict !== "unknown") {
            assert.strictEqual(verdict, expected);
          }

          if (verdict === "unknown") {
            const text = JSON.stringify(expr);

            const readsDropped =
              dropped.some((id) => text.includes(id)) ||
              (dropped.some((id) => PERSON_IDS.includes(id)) &&
                text.includes(A.owner.id));

            assert.isTrue(readsDropped);
          }

          assert.strictEqual(evaluateInBrowser(resolved.value, full), expected);
        }
      ),
      { numRuns: 400, seed: 51 }
    );
  });
});

const evaluateNnf = (node: NnfNode, source: ImageSource): boolean => {
  if (node.op === "and" || node.op === "or") {
    const values = node.args.map((arg) => evaluateNnf(arg, source));

    return node.op === "and" ? values.every(Boolean) : values.some(Boolean);
  }

  if (node.op === "const") {
    return node.value;
  }

  if (node.op !== "atom") {
    throw new Error("Unexpected node.");
  }

  const value = evaluateCondition(makeResolved(ASSET, node.atom), source);

  return node.negated ? !value : value;
};

describe("negation normal form and simplification", () => {
  it("keeps the meaning of the condition and of its negation", () => {
    check(
      property(
        tuple(
          exprArb({ classId: LAPTOP, depth: 6, profile: "recordRule" }),
          personRowsArb,
          assetRowsArb(1)
        ),
        ([expr, people, rows]) => {
          const [row] = rows;

          const checked = checkCondition(expr, {
            classId: LAPTOP,
            profile: "recordRule",
            purpose: "evaluate",
            view: fixtureView,
          });

          if (row === undefined || row.classId !== LAPTOP || !checked.ok) {
            return;
          }

          const resolved = resolveCondition(checked.value, CONTEXT);

          if (!resolved.ok) {
            return;
          }

          const source = sourceFor(row, people);
          const value = evaluateCondition(resolved.value, source);

          assert.strictEqual(
            evaluateNnf(negationNormalForm(resolved.value.root), source),
            value
          );
          assert.strictEqual(
            evaluateNnf(negationNormalForm(resolved.value.root, true), source),
            !value
          );
        }
      ),
      { numRuns: 300, seed: 52 }
    );
  });

  it("substitutes empty for hidden fields without changing the outcome", () => {
    const ids = Object.values(A).map((field) => field.id);

    check(
      property(
        tuple(
          exprArb({ classId: ASSET, depth: 5, profile: "formRule" }),
          subarray(ids),
          personRowsArb,
          assetRowsArb(1),
          constantFrom(...UUID_POOL)
        ),
        ([expr, hiddenIds, people, rows, me]) => {
          const [row] = rows;
          const hidden = new Set(hiddenIds);

          if (row === undefined || row.classId !== ASSET) {
            return;
          }

          const masked = (values: RecordImage): RecordImage =>
            Object.fromEntries(
              Object.entries(values).map(([id, value]) => [
                id,
                hidden.has(id) ? null : value,
              ])
            );

          const full = sourceFor(row, people);

          const source: ImageSource = {
            previous:
              full.previous === null || full.previous === undefined
                ? null
                : masked(full.previous),
            record: masked(full.record),
            targets: full.targets ?? new Map(),
          };

          const context = { ...CONTEXT, me };

          const evaluate = (condition: Expr): boolean | undefined => {
            const checked = checkCondition(condition, {
              classId: ASSET,
              profile: "formRule",
              purpose: "evaluate",
              view: fixtureView,
            });

            const resolved = checked.ok
              ? resolveCondition(checked.value, context)
              : undefined;

            return resolved?.ok === true
              ? evaluateCondition(resolved.value, source)
              : undefined;
          };

          const simplified = simplifyForCaller(expr, {
            classId: ASSET,
            isHidden: (id) => hidden.has(id),
            view: fixtureView,
          });

          const original = evaluate(expr);

          if (original === undefined) {
            return;
          }

          assert.strictEqual(evaluate(simplified), original);
          assert.isFalse(
            JSON.stringify(simplified)
              .split('"')
              .some((part) => hidden.has(part))
          );
        }
      ),
      { numRuns: 300, seed: 53 }
    );
  });
});
