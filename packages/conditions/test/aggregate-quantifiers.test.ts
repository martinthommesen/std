/**
 * `aggregate-quantifiers` (Contracts 5.10, 4.9): `anyPart` and `allParts`,
 * with owner paths in their `where`, together with `partsChanged`, owner
 * atoms, `previous` and `changed`, give the same verdict as a naive
 * evaluator written directly from the contract over generated owners and
 * parts. Aggregate conditions are evaluated in TypeScript only, so this
 * property test replaces the SQL differential test for them.
 *
 * The naive evaluator follows 5.3 and 5.4 for the generated types: a
 * literal comparison or `in` with an empty field is false; a comparison of
 * two paths holds for `eq` when both are empty and is false for any other
 * comparison with an empty side; `ne`, `notIn` and `notEmpty` are `not` of
 * their positive forms; `changed` compares with the owner's previous image
 * (all empty when the transaction created it); `allParts` over no parts is
 * true and `anyPart` false.
 */
import { assert, describe, it } from "@effect/vitest";
import type { StoredOrPlaintext } from "@std/values/compare";
import { isBoolean, isNumber, isString } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import {
  array,
  assert as check,
  boolean,
  constant,
  constantFrom,
  integer,
  letrec,
  oneof,
  option,
  property,
  record as recordOf,
  tuple,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import {
  checkAggregateCondition,
  evaluateAggregate,
  resolveAggregate,
} from "../src/aggregate.ts";
import {
  isCompare,
  isEmptyTest,
  isIn,
  isJunction,
  isMyGroups,
  isPath,
  isQuantifier,
} from "../src/ast.ts";
import type { Compare, Expr, In, Path } from "../src/ast.ts";
import { staticClassView } from "../src/class-view.ts";
import type { FieldInfo } from "../src/class-view.ts";
import type { RecordImage } from "../src/evaluate-core.ts";
import { issueReasons } from "./support/schema.ts";

const OWNER = "0f000000-0000-4000-8000-000000000001";
const PART = "0f000000-0000-4000-8000-000000000002";
const SUB_PART = "0f000000-0000-4000-8000-000000000003";
const OTHER = "0f000000-0000-4000-8000-000000000004";

const field = (
  id: string,
  name: string,
  classId: string,
  type: FieldInfo["type"]
): FieldInfo => ({ classId, id, name, retired: false, type });

const O = {
  num: field("0f000000-0000-4000-8000-0000000000a1", "o_num", OWNER, {
    kind: "integer",
  }),
  text: field("0f000000-0000-4000-8000-0000000000a2", "o_text", OWNER, {
    caseSensitive: true,
    kind: "text",
  }),
} as const;

const P = {
  flag: field("0f000000-0000-4000-8000-0000000000b3", "p_flag", PART, {
    kind: "boolean",
  }),
  num: field("0f000000-0000-4000-8000-0000000000b1", "p_num", PART, {
    kind: "integer",
  }),
  owner: field("0f000000-0000-4000-8000-0000000000b0", "owner", PART, {
    aggregate: true,
    kind: "reference",
    targetClassId: OWNER,
  }),
  text: field("0f000000-0000-4000-8000-0000000000b2", "p_text", PART, {
    caseSensitive: true,
    kind: "text",
  }),
} as const;

const S = {
  extra: field("0f000000-0000-4000-8000-0000000000c1", "s_extra", SUB_PART, {
    kind: "integer",
  }),
} as const;

const view = staticClassView([
  { fields: Object.values(O), id: OWNER, parentId: null },
  { fields: Object.values(P), id: PART, parentId: null },
  { fields: Object.values(S), id: SUB_PART, parentId: PART },
]);

const PART_CLASSES: ReadonlySet<string> = new Set([PART, SUB_PART]);
const TEXTS = ["a", "b", "c"] as const;

/** A generated part: its concrete class and values. */
interface GeneratedPart {
  readonly classId: string;
  readonly num: number | null;
  readonly text: string | null;
  readonly flag: boolean;
  readonly extra: number | null;
}

/** A generated owner with its previous image, parts and changed classes. */
interface Scenario {
  readonly owner: { readonly num: number | null; readonly text: string | null };
  readonly previous: {
    readonly num: number | null;
    readonly text: string | null;
  } | null;
  readonly parts: readonly GeneratedPart[];
  readonly changed: readonly string[];
}

const numArb = option(integer({ max: 3, min: -3 }), { nil: null });
const textArb = option(constantFrom(...TEXTS), { nil: null });

const ownerArb = recordOf({ num: numArb, text: textArb });

const partArb: Arbitrary<GeneratedPart> = recordOf({
  classId: constantFrom(PART, SUB_PART),
  extra: numArb,
  flag: boolean(),
  num: numArb,
  text: textArb,
});

const scenarioArb: Arbitrary<Scenario> = recordOf({
  changed: array(constantFrom(PART, SUB_PART), { maxLength: 2 }),
  owner: ownerArb,
  parts: array(partArb, { maxLength: 5 }),
  previous: option(ownerArb, { nil: null }),
});

const at = (fieldInfo: FieldInfo, extra: Partial<Path> = {}): Path => ({
  path: [fieldInfo.id],
  ...extra,
});

const ownerPath = (fieldInfo: FieldInfo): Path =>
  at(fieldInfo, { scope: "owner" });

const numCompare = (left: Path): Arbitrary<Expr> =>
  tuple(
    constantFrom("eq", "ne", "lt", "le", "gt", "ge"),
    integer({ max: 3, min: -3 })
  ).map(([op, value]): Expr => ({ left, op, right: { value } }));

const textCompare = (left: Path): Arbitrary<Expr> =>
  tuple(constantFrom("eq", "ne"), constantFrom(...TEXTS)).map(
    ([op, value]): Expr => ({ left, op, right: { value } })
  );

const membership = (left: Path, values: Arbitrary<string | number>) =>
  tuple(constantFrom("in", "notIn"), array(values, { maxLength: 3 })).map(
    ([op, list]): Expr => ({
      left,
      op,
      right: list.map((value) => ({ value })),
    })
  );

const emptiness = (arg: Path): Arbitrary<Expr> =>
  constantFrom("empty", "notEmpty").map((op): Expr => ({ arg, op }));

const partAtomArb: Arbitrary<Expr> = oneof(
  numCompare(at(P.num)),
  textCompare(at(P.text)),
  membership(at(P.num), integer({ max: 3, min: -3 })),
  membership(at(P.text), constantFrom(...TEXTS)),
  emptiness(at(P.num)),
  emptiness(at(P.text)),
  constantFrom(true, false).map((value): Expr => ({
    left: at(P.flag),
    op: "eq",
    right: { value },
  })),
  // Part against owner, current and previous.
  tuple(
    constantFrom("eq", "ne", "lt", "ge"),
    constantFrom<"current" | "previous">("current", "previous")
  ).map(([op, image]): Expr => ({
    left: at(P.num),
    op,
    right:
      image === "previous"
        ? { image: "previous", path: [O.num.id], scope: "owner" }
        : ownerPath(O.num),
  })),
  constantFrom("eq", "ne").map((op): Expr => ({
    left: at(P.text),
    op,
    right: ownerPath(O.text),
  })),
  numCompare(ownerPath(O.num)),
  emptiness(ownerPath(O.text))
);

const subPartAtomArb: Arbitrary<Expr> = oneof(
  numCompare(at(S.extra)),
  emptiness(at(S.extra)),
  numCompare(at(P.num))
);

const junction = (inner: Arbitrary<Expr>, depth: number): Arbitrary<Expr> =>
  depth <= 0
    ? inner
    : oneof(
        { arbitrary: inner, weight: 3 },
        tuple(
          constantFrom("and", "or"),
          array(junction(inner, depth - 1), { maxLength: 3 })
        ).map(([op, args]): Expr => ({ args, op })),
        junction(inner, depth - 1).map((arg): Expr => ({ arg, op: "not" }))
      );

const ownerAtomArb: Arbitrary<Expr> = oneof(
  numCompare(at(O.num)),
  textCompare(at(O.text)),
  emptiness(at(O.num)),
  constant<Expr>({ arg: at(O.num), op: "changed" }),
  constant<Expr>({ arg: at(O.text), op: "changed" }),
  constantFrom("eq", "ne").map((op): Expr => ({
    left: at(O.num),
    op,
    right: { image: "previous", path: [O.num.id] },
  })),
  constantFrom(PART, SUB_PART).map((classId): Expr => ({
    class: classId,
    op: "partsChanged",
  })),
  tuple(constantFrom("anyPart", "allParts"), junction(partAtomArb, 2)).map(
    ([op, where]): Expr => ({ class: PART, op, where })
  ),
  tuple(constantFrom("anyPart", "allParts"), junction(subPartAtomArb, 1)).map(
    ([op, where]): Expr => ({ class: SUB_PART, op, where })
  )
);

const conditionArb: Arbitrary<Expr> = letrec<{ node: Expr }>((tie) => ({
  node: oneof(
    { depthSize: "small", withCrossShrink: true },
    { arbitrary: ownerAtomArb, weight: 4 },
    tuple(constantFrom("and", "or"), array(tie("node"), { maxLength: 3 })).map(
      ([op, args]): Expr => ({ args, op })
    ),
    tie("node").map((arg): Expr => ({ arg, op: "not" }))
  ),
})).node;

// The naive evaluator, written from Contracts 5.3, 5.4 and 5.10.

type Value = StoredOrPlaintext;

interface Images {
  readonly self: RecordImage;
  readonly previous: RecordImage | null;
  readonly owner: RecordImage;
  readonly ownerPrevious: RecordImage;
}

const read = (images: Images, path: Path): Value => {
  const [fieldId = ""] = path.path;

  if (path.scope === "owner") {
    return (
      (path.image === "previous" ? images.ownerPrevious : images.owner)[
        fieldId
      ] ?? null
    );
  }

  const image =
    path.image === "previous" ? (images.previous ?? {}) : images.self;

  return image[fieldId] ?? null;
};

const ordered = (op: string, left: Value, right: Value): boolean => {
  if (op === "eq") {
    return left === right;
  }

  if (!(isNumber(left) && isNumber(right))) {
    return false;
  }

  if (op === "lt") {
    return left < right;
  }

  if (op === "le") {
    return left <= right;
  }

  return op === "gt" ? left > right : left >= right;
};

const literalOf = (json: JsonValue): Value =>
  isNumber(json) || isString(json) || isBoolean(json) ? json : null;

const POSITIVE = {
  eq: "eq",
  ge: "ge",
  gt: "gt",
  le: "le",
  lt: "lt",
  ne: "eq",
} as const;

const naiveCompare = (expr: Compare, images: Images): boolean => {
  const positive = POSITIVE[expr.op];
  const left = read(images, expr.left);
  let holds: boolean;

  if (isPath(expr.right)) {
    const right = read(images, expr.right);

    holds =
      left === null || right === null
        ? positive === "eq" && left === right
        : ordered(positive, left, right);
  } else {
    const right = "value" in expr.right ? literalOf(expr.right.value) : null;

    holds = left !== null && ordered(positive, left, right);
  }

  return expr.op === "ne" ? !holds : holds;
};

const naiveIn = (expr: In, images: Images): boolean => {
  const left = read(images, expr.left);

  const list = isMyGroups(expr.right)
    ? []
    : expr.right.flatMap((value) =>
        "value" in value ? [literalOf(value.value)] : []
      );

  const holds = left !== null && list.includes(left);

  return expr.op === "in" ? holds : !holds;
};

const subtreeOf = (classId: string): readonly string[] =>
  classId === PART ? [PART, SUB_PART] : [classId];

const partImage = (part: GeneratedPart): RecordImage => {
  const image = {
    [P.flag.id]: part.flag,
    [P.num.id]: part.num,
    [P.owner.id]: "0f000000-0000-4000-8000-00000000ffff",
    [P.text.id]: part.text,
  } satisfies RecordImage;

  return part.classId === SUB_PART
    ? { ...image, [S.extra.id]: part.extra }
    : image;
};

const naiveAtom = (expr: Expr, images: Images, source: Scenario): boolean => {
  if (isCompare(expr)) {
    return naiveCompare(expr, images);
  }

  if (isIn(expr)) {
    return naiveIn(expr, images);
  }

  if (isEmptyTest(expr)) {
    const empty = read(images, expr.arg) === null;

    return expr.op === "empty" ? empty : !empty;
  }

  if (expr.op === "changed") {
    const [fieldId = ""] = expr.arg.path;

    return images.self[fieldId] !== (images.previous?.[fieldId] ?? null);
  }

  if (expr.op === "partsChanged") {
    return source.changed.some((classId) =>
      subtreeOf(expr.class).includes(classId)
    );
  }

  throw new Error(`The generator made no ${expr.op}.`);
};

const naive = (expr: Expr, images: Images, source: Scenario): boolean => {
  if (isJunction(expr)) {
    return expr.op === "and"
      ? expr.args.every((arg) => naive(arg, images, source))
      : expr.args.some((arg) => naive(arg, images, source));
  }

  if (expr.op === "not") {
    return !naive(expr.arg, images, source);
  }

  if (expr.op === "true" || expr.op === "false") {
    return expr.op === "true";
  }

  if (!isQuantifier(expr)) {
    return naiveAtom(expr, images, source);
  }

  const matches = source.parts
    .filter((part) => subtreeOf(expr.class).includes(part.classId))
    .map((part) =>
      naive(
        expr.where,
        {
          owner: images.owner,
          ownerPrevious: images.ownerPrevious,
          previous: null,
          self: partImage(part),
        },
        source
      )
    );

  return expr.op === "anyPart"
    ? matches.includes(true)
    : matches.every(Boolean);
};

const ownerImageOf = (
  values: { readonly num: number | null; readonly text: string | null } | null
): RecordImage => ({
  [O.num.id]: values?.num ?? null,
  [O.text.id]: values?.text ?? null,
});

const evaluateWithEngine = (expr: Expr, scenario: Scenario): boolean => {
  const checked = checkAggregateCondition(expr, {
    classId: OWNER,
    isPartClass: (classId) => PART_CLASSES.has(classId),
    purpose: "evaluate",
    view,
  });

  if (!checked.ok) {
    throw checked.error;
  }

  const resolved = resolveAggregate(checked.value, {
    now: 0,
    timeZone: "UTC",
  });

  if (!resolved.ok) {
    throw resolved.error;
  }

  return evaluateAggregate(resolved.value, {
    owner: ownerImageOf(scenario.owner),
    parts: (classId) =>
      scenario.parts
        .filter((part) => subtreeOf(classId).includes(part.classId))
        .map((part) => partImage(part)),
    partsChanged: (classId) =>
      scenario.changed.some((changed) => subtreeOf(classId).includes(changed)),
    previous:
      scenario.previous === null ? null : ownerImageOf(scenario.previous),
    targets: new Map(),
  });
};

const evaluateNaively = (expr: Expr, scenario: Scenario): boolean => {
  const owner = ownerImageOf(scenario.owner);
  const ownerPrevious = ownerImageOf(scenario.previous);

  return naive(
    expr,
    {
      owner,
      ownerPrevious,
      previous: ownerPrevious,
      self: owner,
    },
    scenario
  );
};

describe("aggregate-quantifiers", () => {
  it("anyPart and allParts with owner paths agree with a naive evaluator", () => {
    const verdicts = { false: 0, true: 0 };
    let quantified = 0;

    check(
      property(conditionArb, scenarioArb, (expr, scenario) => {
        const verdict = evaluateWithEngine(expr, scenario);

        assert.strictEqual(verdict, evaluateNaively(expr, scenario));
        verdicts[verdict ? "true" : "false"] += 1;

        if (JSON.stringify(expr).includes("Part")) {
          quantified += 1;
        }
      }),
      { numRuns: 2000, seed: 4909 }
    );

    // The generator reaches both verdicts and the quantifiers often.
    assert.isAbove(verdicts.true, 200);
    assert.isAbove(verdicts.false, 200);
    assert.isAbove(quantified, 300);
  });

  it("allParts over no parts is true and anyPart is false", () => {
    const empty: Scenario = {
      changed: [],
      owner: { num: 1, text: "a" },
      parts: [],
      previous: null,
    };

    const where: Expr = { left: at(P.num), op: "eq", right: { value: 1 } };

    assert.isTrue(
      evaluateWithEngine({ class: PART, op: "allParts", where }, empty)
    );
    assert.isFalse(
      evaluateWithEngine({ class: PART, op: "anyPart", where }, empty)
    );
  });

  it("validates the resolver context only when an owner or part leaf needs it", () => {
    const cases: readonly {
      readonly expr: Expr;
      readonly expected: readonly string[];
    }[] = [
      { expected: [], expr: { class: PART, op: "partsChanged" } },
      { expected: [], expr: { args: [], op: "and" } },
      { expected: [], expr: { args: [], op: "or" } },
      { expected: ["invalidTimeZone"], expr: { arg: at(O.num), op: "empty" } },
      {
        expected: ["invalidTimeZone"],
        expr: {
          class: PART,
          op: "anyPart",
          where: { arg: at(P.num), op: "empty" },
        },
      },
    ];

    for (const { expr, expected } of cases) {
      const checked = checkAggregateCondition(expr, {
        classId: OWNER,
        isPartClass: (classId) => PART_CLASSES.has(classId),
        purpose: "evaluate",
        view,
      });

      if (!checked.ok) {
        throw checked.error;
      }

      const resolved = resolveAggregate(checked.value, {
        now: 0,
        timeZone: "invalid",
      });

      assert.strictEqual(resolved.ok, expected.length === 0);
      assert.deepStrictEqual(issueReasons(resolved), expected);
    }
  });

  it("a class that is no part class is refused", () => {
    const checked = checkAggregateCondition(
      { class: OTHER, op: "partsChanged" },
      {
        classId: OWNER,
        isPartClass: (classId) => PART_CLASSES.has(classId),
        purpose: "store",
        view,
      }
    );

    assert.isFalse(checked.ok);
    assert.deepStrictEqual(issueReasons(checked), ["notAPart"]);
  });

  it("a part condition refuses changed, a part's previous and nested quantifiers", () => {
    const refused: readonly Expr[] = [
      { arg: at(P.num), op: "changed" },
      {
        left: at(P.num, { image: "previous" }),
        op: "eq",
        right: { value: 1 },
      },
      { class: SUB_PART, op: "partsChanged" },
      {
        class: SUB_PART,
        op: "anyPart",
        where: { op: "true" },
      },
    ];

    for (const where of refused) {
      const checked = checkAggregateCondition(
        { class: PART, op: "anyPart", where },
        {
          classId: OWNER,
          isPartClass: (classId) => PART_CLASSES.has(classId),
          purpose: "store",
          view,
        }
      );

      assert.isFalse(checked.ok, JSON.stringify(where));
    }
  });
});
