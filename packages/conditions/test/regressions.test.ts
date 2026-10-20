/**
 * Regression tests for review round 1 of `ws/1d-conditions`: unset
 * write-only states, null-aware booleans in the simplifier, integral
 * offsets, the browser's code-point check on every text read, and depth
 * limits on text and JSON input.
 */
import { assert, describe, it } from "@effect/vitest";
import { isString } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import { secretState } from "@std/values/write-only";
import { assert as check, property, record, subarray } from "fast-check";

import { decodeExpr, exprDepth } from "../src/ast.ts";
import type { Expr, Path } from "../src/ast.ts";
import { evaluateInBrowser } from "../src/browser.ts";
import { checkCondition, checkConditionJson } from "../src/check.ts";
import { ConditionDefectError } from "../src/defect.ts";
import type { ImageSource, RecordImage } from "../src/evaluate-core.ts";
import { evaluateCondition } from "../src/evaluate.ts";
import { resolveCondition } from "../src/resolve.ts";
import type { ConditionContext } from "../src/resolve.ts";
import { simplifyForCaller } from "../src/simplify.ts";
import { parseCondition } from "../src/syntax-parse.ts";
import { printCondition } from "../src/syntax-print.ts";
import { makeChecked } from "../src/typed.ts";
import type { ResolvedCondition } from "../src/typed.ts";
import { assetRowsArb, exprArb, personRowsArb } from "./support/generate.ts";
import { sourceFor } from "./support/images.ts";
import { PERSON_IDS } from "./support/pools.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  PERSON_FIELDS as P,
  PERSON_LIST,
  PERSON_VIP,
} from "./support/schema.ts";

const CONTEXT: ConditionContext = {
  me: "00000000-0000-7000-8000-000000010000",
  now: Date.UTC(2026, 9, 20, 12),
  timeZone: "UTC",
};

const UNASSIGNED = "͸";
const DEEP = 2000;

const path = (...fields: readonly { readonly id: string }[]): Path => ({
  path: fields.map((field) => field.id),
});

const prepare = (
  expr: Expr,
  profile: "formRule" | "filter" = "formRule"
): ResolvedCondition => {
  const checked = checkCondition(expr, {
    classId: ASSET,
    profile,
    purpose: "evaluate",
    view: fixtureView,
  });

  if (!checked.ok) {
    throw checked.error;
  }

  const resolved = resolveCondition(checked.value, CONTEXT);

  if (!resolved.ok) {
    throw resolved.error;
  }

  return resolved.value;
};

const EMPTY_ASSET: RecordImage = Object.fromEntries(
  Object.values(A).map((field) => [field.id, null])
);

const EMPTY_PERSON: RecordImage = Object.fromEntries(
  PERSON_LIST.map((field) => [field.id, null])
);

// `depth` nots around an atom.
const nestedAround = (depth: number, atom: Expr): Expr => {
  let expr = atom;

  for (let level = 0; level < depth; level += 1) {
    expr = { arg: expr, op: "not" };
  }

  return expr;
};

const nested = (depth: number, wrap: (inner: Expr) => Expr): Expr => {
  let expr: Expr = { op: "true" };

  for (let level = 0; level < depth; level += 1) {
    expr = wrap(expr);
  }

  return expr;
};

const simplifiedAgrees = (
  expr: Expr,
  hidden: ReadonlySet<string>,
  source: ImageSource
) => {
  const simplified = simplifyForCaller(expr, {
    classId: ASSET,
    isHidden: (id) => hidden.has(id),
    view: fixtureView,
  });

  return {
    original: evaluateCondition(prepare(expr), source),
    simplified: evaluateCondition(prepare(simplified), source),
  };
};

const poison = (image: RecordImage, ids: ReadonlySet<string>): RecordImage =>
  Object.fromEntries(
    Object.entries(image).map(([id, value]) => [
      id,
      ids.has(id) && isString(value) ? `${value}${UNASSIGNED}` : value,
    ])
  );

describe("unset password and secret states", () => {
  it("treat { set: false } like null and { set: true } as set, in both evaluators", () => {
    for (const field of [A.key, A.token]) {
      const empty: Expr = { arg: path(field), op: "empty" };
      const condition = prepare(empty);

      const verdict = (value: RecordImage[string]) =>
        evaluateCondition(condition, {
          record: { ...EMPTY_ASSET, [field.id]: value },
        });

      assert.isTrue(verdict(null));
      assert.isTrue(verdict(secretState(false)));
      assert.isFalse(verdict(secretState(true)));
      assert.strictEqual(
        evaluateInBrowser(condition, {
          record: { [field.id]: secretState(false) },
        }),
        true
      );
    }
  });
});

describe("booleans in the simplifier stay null-aware", () => {
  const owner = PERSON_IDS[0] ?? "";

  it("hidden flag = previous.active on create is true, as unsimplified", () => {
    const expr: Expr = {
      left: path(A.owner, PERSON_VIP),
      op: "eq",
      right: { image: "previous", path: [A.active.id] },
    };

    const result = simplifiedAgrees(expr, new Set([A.owner.id]), {
      previous: null,
      record: { ...EMPTY_ASSET, [A.active.id]: true },
    });

    assert.deepStrictEqual(result, { original: true, simplified: true });
  });

  it("agrees when the other boolean is conditionally masked or behind an empty reference", () => {
    const masked: Expr = {
      left: path(A.owner, PERSON_VIP),
      op: "eq",
      right: path(A.active),
    };

    const viaReference: Expr = {
      left: path(A.active),
      op: "ne",
      right: path(A.owner, PERSON_VIP),
    };

    assert.deepStrictEqual(
      simplifiedAgrees(masked, new Set([A.owner.id]), { record: EMPTY_ASSET }),
      { original: true, simplified: true }
    );
    assert.deepStrictEqual(
      simplifiedAgrees(viaReference, new Set([A.active.id]), {
        record: { ...EMPTY_ASSET, [A.owner.id]: owner },
        targets: new Map([[owner, null]]),
      }),
      { original: false, simplified: false }
    );
    assert.deepStrictEqual(
      simplifiedAgrees(viaReference, new Set([A.active.id]), {
        record: { ...EMPTY_ASSET, [A.owner.id]: owner },
        targets: new Map([[owner, { ...EMPTY_PERSON, [PERSON_VIP.id]: true }]]),
      }),
      { original: true, simplified: true }
    );
  });
});

describe("only password and secret have unset states", () => {
  it("a json value shaped like { set: false } is data in both evaluators", () => {
    const empty = prepare({ arg: path(A.data), op: "empty" });
    const changed = prepare({ arg: path(A.data), op: "changed" });

    for (const data of [{ set: false }, { set: true }]) {
      const image = { ...EMPTY_ASSET, [A.data.id]: data };

      assert.isFalse(evaluateCondition(empty, { record: image }));
      assert.isTrue(
        evaluateCondition(changed, { previous: null, record: image })
      );
      assert.strictEqual(evaluateInBrowser(empty, { record: image }), false);
      assert.strictEqual(
        evaluateInBrowser(changed, { previous: null, record: image }),
        true
      );
    }
  });
});

describe("the boolean rewrite keeps the condition's depth", () => {
  it("simplifies a 64-level condition into one that still checks", () => {
    const atom: Expr = {
      left: path(A.active),
      op: "eq",
      right: path(A.owner, PERSON_VIP),
    };

    const expr = nestedAround(63, atom);

    const simplified = simplifyForCaller(expr, {
      classId: ASSET,
      isHidden: (id) => id === A.active.id,
      view: fixtureView,
    });

    const owner = PERSON_IDS[0] ?? "";

    const source: ImageSource = {
      record: { ...EMPTY_ASSET, [A.owner.id]: owner },
      targets: new Map([[owner, { ...EMPTY_PERSON, [PERSON_VIP.id]: null }]]),
    };

    assert.strictEqual(exprDepth(expr), 64);
    assert.strictEqual(exprDepth(simplified), 64);
    assert.strictEqual(
      evaluateCondition(prepare(simplified), source),
      evaluateCondition(prepare(expr), source)
    );
  });
});

describe("relative offsets are whole numbers", () => {
  it("the checker refuses fractional offsets and anything else the schema refuses", () => {
    const fractional = checkCondition(
      {
        left: path(A.due),
        op: "lt",
        right: { offset: 0.5, rel: "now", unit: "day" },
      },
      { classId: ASSET, profile: "filter", purpose: "store", view: fixtureView }
    );

    const period = checkCondition(
      {
        left: path(A.due),
        op: "inPeriod",
        period: { offset: 1.5, unit: "week" },
      },
      { classId: ASSET, profile: "filter", purpose: "store", view: fixtureView }
    );

    assert.isFalse(fractional.ok);
    assert.isFalse(period.ok);
  });

  it("the resolver treats non-integral arithmetic as a defect, not as out of range", () => {
    const due = checkCondition(
      { arg: path(A.opened), op: "empty" },
      { classId: ASSET, profile: "filter", purpose: "store", view: fixtureView }
    );

    assert.isTrue(due.ok);

    if (!due.ok || due.value.root.op !== "empty") {
      return;
    }

    const left = due.value.root.arg;

    const forged = makeChecked(ASSET, {
      compare: "lt",
      left,
      op: "compare",
      right: { kind: "relNow", offset: 0.5, unit: "day" },
    });

    assert.throws(() => {
      resolveCondition(forged, CONTEXT);
    }, ConditionDefectError);
  });
});

describe("the browser checks code points on every text read", () => {
  const owner = PERSON_IDS[1] ?? "";

  it("returns Unknown for unassigned code points in previous and target text", () => {
    const previous = prepare({
      left: { image: "previous", path: [A.name.id] },
      op: "eq",
      right: { value: "x" },
    });

    const target = prepare({
      left: path(A.owner, P.name),
      op: "eq",
      right: { value: "x" },
    });

    assert.strictEqual(
      evaluateInBrowser(previous, {
        previous: { ...EMPTY_ASSET, [A.name.id]: `x${UNASSIGNED}` },
        record: EMPTY_ASSET,
      }),
      "unknown"
    );
    assert.strictEqual(
      evaluateInBrowser(target, {
        record: { ...EMPTY_ASSET, [A.owner.id]: owner },
        targets: new Map([
          [owner, { ...EMPTY_PERSON, [P.name.id]: `x${UNASSIGNED}` }],
        ]),
      }),
      "unknown"
    );
  });

  it("stays sound with unassigned text in the record, previous and target images", () => {
    const textIds = [
      A.name.id,
      A.code.id,
      A.notes.id,
      A.transcript.id,
      P.name.id,
      P.code.id,
    ];

    check(
      property(
        record({
          expr: exprArb({ classId: ASSET, depth: 4, profile: "formRule" }),
          people: personRowsArb,
          poisoned: subarray(textIds),
          rows: assetRowsArb(1),
        }),
        ({ expr, people, poisoned, rows }) => {
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

          const ids = new Set(poisoned);
          const full = sourceFor(row, people);

          const source: ImageSource = {
            previous:
              full.previous === null || full.previous === undefined
                ? null
                : poison(full.previous, ids),
            record: poison(full.record, ids),
            targets: new Map(
              [...(full.targets ?? new Map<string, RecordImage | null>())].map(
                ([id, image]) => [
                  id,
                  image === null ? null : poison(image, ids),
                ]
              )
            ),
          };

          const verdict = evaluateInBrowser(resolved.value, source);

          if (verdict !== "unknown") {
            assert.strictEqual(
              verdict,
              evaluateCondition(resolved.value, source)
            );
          }
        }
      ),
      { numRuns: 400, seed: 81 }
    );
  });
});

describe("depth limits", () => {
  const options = {
    classId: ASSET,
    resolveName: fixtureView.fieldByName ?? (() => {}),
  };

  const tooDeepAt = (text: string) => {
    const result = parseCondition(text, options);

    return result.ok ? undefined : result.error.issues[0];
  };

  it("the parser refuses deep nesting with a positioned error instead of overflowing", () => {
    for (const text of [
      `${"(".repeat(DEEP)}true${")".repeat(DEEP)}`,
      `${"not ".repeat(DEEP)}true`,
      `${"all(".repeat(DEEP)}true${")".repeat(DEEP)}`,
      `${"any(not (".repeat(DEEP)}true${"))".repeat(DEEP)}`,
    ]) {
      const found = tooDeepAt(text);
      assert.strictEqual(found?.reason, "tooDeep");
      assert.isDefined(found?.span);
    }

    assert.isTrue(
      parseCondition(`${"(".repeat(60)}true${")".repeat(60)}`, options).ok
    );
  });

  it("deep ASTs from JSON or code get typed errors, never a stack overflow", () => {
    let json: JsonValue = { op: "true" };

    for (let level = 0; level < 100_000; level += 1) {
      json = { arg: json, op: "not" };
    }

    const decoded = decodeExpr(json);
    assert.isTrue(decoded._tag === "Failure" && decoded.failure === "tooDeep");

    const checkedJson = checkConditionJson(json, {
      classId: ASSET,
      profile: "filter",
      purpose: "store",
      view: fixtureView,
    });

    assert.strictEqual(
      checkedJson.ok ? undefined : checkedJson.error.issues[0]?.reason,
      "tooDeep"
    );

    const deep = nested(100_000, (inner) => ({ args: [inner], op: "and" }));

    const checked = checkCondition(deep, {
      classId: ASSET,
      profile: "filter",
      purpose: "store",
      view: fixtureView,
    });

    const printed = printCondition(deep, {
      classId: ASSET,
      field: fixtureView.field,
    });

    assert.strictEqual(
      checked.ok ? undefined : checked.error.issues[0]?.reason,
      "tooDeep"
    );
    assert.strictEqual(
      printed.ok ? undefined : printed.error.issues[0]?.reason,
      "tooDeep"
    );
    assert.throws(() => {
      simplifyForCaller(deep, {
        classId: ASSET,
        isHidden: () => false,
        view: fixtureView,
      });
    }, ConditionDefectError);

    const limit = nested(63, (inner) => ({ args: [inner], op: "or" }));
    assert.isTrue(
      checkCondition(limit, {
        classId: ASSET,
        profile: "filter",
        purpose: "store",
        view: fixtureView,
      }).ok
    );
  });
});
