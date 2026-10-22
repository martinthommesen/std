/**
 * Record-scoped paths (Contracts 4.10): a record rule's `forEach.where`
 * reads the rule's own record on the right of `eq` to `ge`. The checker
 * allows them only when told the record's class, and only there; the
 * resolver turns them into literals, with `eq(f, g)` semantics for an
 * empty value.
 */
import { assert, describe, it } from "@effect/vitest";

import type { Expr, Path } from "../src/ast.ts";
import { checkCondition } from "../src/check.ts";
import type { CheckOptions } from "../src/check.ts";
import type { RecordImage } from "../src/evaluate-core.ts";
import { evaluateCondition } from "../src/evaluate.ts";
import { resolveCondition } from "../src/resolve.ts";
import type { ConditionContext } from "../src/resolve.ts";
import { printCondition } from "../src/syntax-print.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  PERSON,
  PERSON_FIELDS as P,
} from "./support/schema.ts";

const WITHOUT_RECORD: CheckOptions = {
  classId: ASSET,
  profile: "recordRule",
  purpose: "store",
  view: fixtureView,
};

const OPTIONS: CheckOptions = { ...WITHOUT_RECORD, recordClassId: PERSON };

const field = (id: string): Path => ({ path: [id] });
const recordField = (id: string): Path => ({ path: [id], scope: "record" });
const RECORD_ID: Path = { path: [], scope: "record" };

const PERSON_ID = "0192f000-0000-7000-8000-0000000000aa";

const asset = (values: RecordImage): RecordImage => ({
  ...Object.fromEntries(Object.values(A).map((entry) => [entry.id, null])),
  ...values,
});

type RuleRecord = NonNullable<ConditionContext["record"]>;

const holds = (expr: Expr, record: RuleRecord, image: RecordImage): boolean => {
  const checked = checkCondition(expr, OPTIONS);

  if (!checked.ok) {
    throw checked.error;
  }

  const resolved = resolveCondition(checked.value, {
    now: Date.UTC(2026, 9, 22),
    record,
    timeZone: "UTC",
  });

  if (!resolved.ok) {
    throw resolved.error;
  }

  return evaluateCondition(resolved.value, { record: image });
};

const reasons = (expr: Expr, options: CheckOptions = OPTIONS) => {
  const checked = checkCondition(expr, options);

  return checked.ok ? [] : checked.error.issues.map((entry) => entry.reason);
};

describe("record-scope", () => {
  it("compares a reference with the rule's record ID", () => {
    const expr: Expr = { left: field(A.owner.id), op: "eq", right: RECORD_ID };
    const person = { id: PERSON_ID, values: {} };

    assert.isTrue(holds(expr, person, asset({ [A.owner.id]: PERSON_ID })));
    assert.isFalse(holds(expr, person, asset({ [A.owner.id]: null })));
  });

  it("compares with a field of the rule's record; empty is eq(f, g)", () => {
    const expr: Expr = {
      left: field(A.count.id),
      op: "eq",
      right: recordField(P.rank.id),
    };

    const ranked = { id: PERSON_ID, values: { [P.rank.id]: 3 } };
    const unranked = { id: PERSON_ID, values: { [P.rank.id]: null } };

    assert.isTrue(holds(expr, ranked, asset({ [A.count.id]: 3 })));
    assert.isFalse(holds(expr, ranked, asset({ [A.count.id]: 4 })));
    assert.isTrue(holds(expr, unranked, asset({ [A.count.id]: null })));
    assert.isFalse(holds(expr, unranked, asset({ [A.count.id]: 3 })));

    const ordered: Expr = {
      left: field(A.count.id),
      op: "lt",
      right: recordField(P.rank.id),
    };

    assert.isTrue(holds(ordered, ranked, asset({ [A.count.id]: 2 })));
    assert.isFalse(holds(ordered, unranked, asset({ [A.count.id]: 2 })));
  });

  it("is refused without the record's class, on the left, in hops and across comparison classes", () => {
    const right: Expr = {
      left: field(A.count.id),
      op: "eq",
      right: recordField(P.rank.id),
    };

    assert.deepStrictEqual(reasons(right, WITHOUT_RECORD), ["scopeNotAllowed"]);
    assert.deepStrictEqual(
      reasons({ arg: recordField(P.rank.id), op: "empty" }),
      ["scopeNotAllowed"]
    );
    assert.deepStrictEqual(
      reasons({
        left: field(A.count.id),
        op: "eq",
        right: { path: [P.manager.id, P.rank.id], scope: "record" },
      }),
      ["tooManyHops"]
    );
    assert.deepStrictEqual(
      reasons({
        left: field(A.name.id),
        op: "eq",
        right: recordField(P.rank.id),
      }),
      ["comparisonClassMismatch"]
    );
    assert.deepStrictEqual(
      reasons({ left: field(A.name.id), op: "eq", right: RECORD_ID }),
      ["contextNotForType"]
    );
    assert.deepStrictEqual(
      reasons({
        left: field(A.count.id),
        op: "eq",
        right: { image: "previous", path: [P.rank.id], scope: "record" },
      }),
      ["previousNotAllowed"]
    );
  });

  it("has no text syntax", () => {
    const printed = printCondition(
      { left: field(A.owner.id), op: "eq", right: RECORD_ID },
      { classId: ASSET, field: fixtureView.field }
    );

    assert.isFalse(printed.ok);
  });
});
