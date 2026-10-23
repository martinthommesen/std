import { assert, describe, it } from "@effect/vitest";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import { getOrThrow } from "@std/values/field-error";
import type { ConditionProfile } from "@std/values/field-type";

import type { Expr, Value } from "../src/ast.ts";
import { checkCondition } from "../src/check.ts";
import { resolveCondition, timeZoneFor } from "../src/resolve.ts";
import type { ConditionContext } from "../src/resolve.ts";
import type { ResolvedNode } from "../src/typed.ts";
import {
  ASSET,
  ASSET_FIELDS as A,
  fixtureView,
  path,
  prepareCondition,
} from "./support/schema.ts";

const HOUR = 3_600_000;

const at = (text: string): number => getOrThrow(parseDateTime(text));

const resolve = (
  expr: Expr,
  context: Partial<ConditionContext> & { readonly now: number },
  profile: ConditionProfile = "filter"
): ResolvedNode =>
  prepareCondition(
    expr,
    {
      classId: ASSET,
      profile,
      purpose: "store",
      view: fixtureView,
    },
    {
      timeZone: "UTC",
      ...context,
    }
  ).root;

// The literal bounds of a resolved tree, in order, as canonical text.
const bounds = (node: ResolvedNode): string[] => {
  if (node.op === "and" || node.op === "or") {
    return node.args.flatMap((arg) => bounds(arg));
  }

  if (node.op === "not") {
    return bounds(node.arg);
  }

  if (node.op === "compare" && node.right.kind === "literal") {
    const { value } = node.right;

    if (value.kind === "dateTime") {
      return [formatDateTime(value.value)];
    }

    return value.kind === "date" ? [value.value] : [];
  }

  return [];
};

const instants = (node: ResolvedNode): number[] =>
  bounds(node).map((text) => at(text));

const opened = (right: Value): Expr => ({
  left: path(A.opened),
  op: "ge",
  right,
});

const period = (unit: "week" | "quarter" | "year", offset: number): Expr => ({
  left: path(A.due),
  op: "inPeriod",
  period: { offset, unit },
});

describe("resolver", () => {
  it("now - 1 day is calendar arithmetic: 25 hours across the fall DST change", () => {
    const now = at("2026-10-25T12:00:00.000Z");

    const [start = 0] = instants(
      resolve(opened({ offset: -1, rel: "now", unit: "day" }), {
        now,
        timeZone: "Europe/Berlin",
      })
    );

    assert.strictEqual(now - start, 25 * HOUR);
  });

  it("now - 1 day is 23 hours across the spring DST change", () => {
    const now = at("2026-03-29T12:00:00.000Z");

    const [start = 0] = instants(
      resolve(opened({ offset: -1, rel: "now", unit: "day" }), {
        now,
        timeZone: "Europe/Berlin",
      })
    );

    assert.strictEqual(now - start, 23 * HOUR);
  });

  it("minute and hour offsets are exact durations", () => {
    const now = at("2026-10-25T12:00:00.000Z");

    const [hours = 0] = instants(
      resolve(opened({ offset: -24, rel: "now", unit: "hour" }), {
        now,
        timeZone: "Europe/Berlin",
      })
    );

    const [minutes = 0] = instants(
      resolve(opened({ offset: 90, rel: "now", unit: "minute" }), {
        now,
        timeZone: "Europe/Berlin",
      })
    );

    assert.strictEqual(now - hours, 24 * HOUR);
    assert.strictEqual(minutes - now, 90 * 60_000);
  });

  it("inPeriod(day, 0) in Europe/Berlin on 2026-10-25 lasts 25 hours", () => {
    const [start = 0, end = 0] = instants(
      resolve(
        {
          left: path(A.opened),
          op: "inPeriod",
          period: { offset: 0, unit: "day" },
        },
        { now: at("2026-10-25T09:30:00.000Z"), timeZone: "Europe/Berlin" }
      )
    );

    assert.strictEqual(formatDateTime(start), "2026-10-24T22:00:00.000Z");
    assert.strictEqual(end - start, 25 * HOUR);
  });

  it("a day without a local midnight starts at its first instant", () => {
    // America/Santiago skips 00:00 to 01:00 on 2026-09-06.
    const [start = ""] = bounds(
      resolve(
        {
          left: path(A.opened),
          op: "inPeriod",
          period: { offset: 0, unit: "day" },
        },
        { now: at("2026-09-06T15:00:00.000Z"), timeZone: "America/Santiago" }
      )
    );

    assert.strictEqual(start, "2026-09-06T04:00:00.000Z");
  });

  it("Jan 31 plus 1 month clamps to the end of February", () => {
    const plusMonth: Expr = {
      left: path(A.due),
      op: "lt",
      right: { offset: 1, rel: "today", unit: "month" },
    };

    assert.deepStrictEqual(
      bounds(resolve(plusMonth, { now: at("2026-01-31T12:00:00.000Z") })),
      ["2026-02-28"]
    );
    assert.deepStrictEqual(
      bounds(resolve(plusMonth, { now: at("2028-01-31T12:00:00.000Z") })),
      ["2028-02-29"]
    );
    assert.deepStrictEqual(
      bounds(
        resolve(opened({ offset: 1, rel: "now", unit: "month" }), {
          now: at("2026-01-31T10:15:00.000Z"),
        })
      ),
      ["2026-02-28T10:15:00.000Z"]
    );
  });

  it("date fields get dates and date-time fields get instants", () => {
    const now = at("2026-10-20T23:30:00.000Z");
    const today = { offset: 0, rel: "today", unit: "day" } as const;

    assert.deepStrictEqual(
      bounds(
        resolve(
          { left: path(A.due), op: "eq", right: today },
          {
            now,
            timeZone: "Asia/Kathmandu",
          }
        )
      ),
      ["2026-10-21"]
    );
    assert.deepStrictEqual(
      bounds(resolve(opened(today), { now, timeZone: "Asia/Kathmandu" })),
      ["2026-10-20T18:15:00.000Z"]
    );
  });

  it("periods start on the week start, quarter and year", () => {
    // 2026-10-20 is a Tuesday.
    const now = at("2026-10-20T12:00:00.000Z");

    assert.deepStrictEqual(bounds(resolve(period("week", 0), { now })), [
      "2026-10-19",
      "2026-10-26",
    ]);
    assert.deepStrictEqual(
      bounds(resolve(period("week", -1), { now, weekStart: 7 })),
      ["2026-10-11", "2026-10-18"]
    );
    assert.deepStrictEqual(bounds(resolve(period("quarter", 1), { now })), [
      "2027-01-01",
      "2027-04-01",
    ]);
    assert.deepStrictEqual(bounds(resolve(period("year", -1), { now })), [
      "2025-01-01",
      "2026-01-01",
    ]);
  });

  it("turns bounds outside years 0001 to 9999 into the constant they denote", () => {
    const now = at("2026-10-20T12:00:00.000Z");
    const far = { offset: 9000, rel: "today", unit: "year" } as const;

    const below = resolve({ left: path(A.due), op: "lt", right: far }, { now });

    assert.strictEqual(below.op, "not");
    assert.strictEqual(below.op === "not" ? below.arg.op : undefined, "empty");
    assert.deepStrictEqual(
      resolve({ left: path(A.due), op: "eq", right: far }, { now }),
      { op: "const", value: false }
    );

    const list = resolve(
      { left: path(A.due), op: "in", right: [far, { value: "2026-01-01" }] },
      { now }
    );

    assert.strictEqual(list.op === "in" ? list.right.length : 0, 1);
  });

  it("an access rule using today decides the same whatever the user's zone", () => {
    const now = at("2026-10-20T23:30:00.000Z");

    const rule: Expr = {
      left: path(A.due),
      op: "lt",
      right: { offset: 0, rel: "today", unit: "day" },
    };

    const forUser = (user: string): string[] =>
      bounds(
        resolve(
          rule,
          {
            now,
            timeZone: timeZoneFor("accessRule", { instance: "UTC", user }),
          },
          "accessRule"
        )
      );

    assert.deepStrictEqual(
      forUser("Pacific/Kiritimati"),
      forUser("Pacific/Pago_Pago")
    );
    assert.strictEqual(
      timeZoneFor("filter", { instance: "UTC", user: "Asia/Tokyo" }),
      "Asia/Tokyo"
    );
    assert.strictEqual(timeZoneFor("filter", { instance: "UTC" }), "UTC");
    assert.strictEqual(
      timeZoneFor("formRule", { instance: "UTC", user: "Asia/Tokyo" }),
      "UTC"
    );
  });

  it("resolves me and myGroups, and marks missing context unavailable", () => {
    const me = "01920c4e-0000-7000-8000-000000000001";

    const root = resolve(
      { left: path(A.owner), op: "eq", right: { ctx: "me" } },
      { me, now: 0 }
    );

    const missing = resolve(
      { left: path(A.owner), op: "eq", right: { ctx: "me" } },
      { now: 0 }
    );

    assert.deepStrictEqual(root.op === "compare" ? root.right : undefined, {
      kind: "literal",
      value: { kind: "uuid", value: me },
    });
    assert.deepStrictEqual(
      missing.op === "compare" ? missing.right : undefined,
      {
        kind: "unavailable",
      }
    );
  });

  it("refuses leap seconds in literals and invalid zones in the context", () => {
    const checked = checkCondition(
      {
        left: path(A.opened),
        op: "eq",
        right: { value: "2016-12-31T23:59:60Z" },
      },
      { classId: ASSET, profile: "filter", purpose: "store", view: fixtureView }
    );

    assert.isFalse(checked.ok);

    const valid = checkCondition(
      { arg: path(A.opened), op: "empty" },
      { classId: ASSET, profile: "filter", purpose: "store", view: fixtureView }
    );

    assert.isTrue(valid.ok);

    if (valid.ok) {
      const zone = resolveCondition(valid.value, {
        now: 0,
        timeZone: "Mars/Olympus",
      });

      const context: ConditionContext = {
        now: 0,
        timeZone: "UTC",
        weekStart: 1,
      };

      // An untyped caller passing an out-of-range week start.
      Object.assign(context, { weekStart: 9 });

      const week = resolveCondition(valid.value, context);

      assert.strictEqual(
        zone.ok ? undefined : zone.error.issues[0]?.reason,
        "invalidTimeZone"
      );
      assert.strictEqual(
        week.ok ? undefined : week.error.issues[0]?.reason,
        "invalidWeekStart"
      );
    }
  });

  it("uses an injected Temporal, and needs one when the global is missing", () => {
    const checked = checkCondition(
      opened({ offset: 0, rel: "today", unit: "day" }),
      {
        classId: ASSET,
        profile: "filter",
        purpose: "store",
        view: fixtureView,
      }
    );

    assert.isTrue(checked.ok);

    if (!checked.ok) {
      return;
    }

    const injected = Temporal;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Temporal");

    Reflect.deleteProperty(globalThis, "Temporal");

    try {
      const missing = resolveCondition(checked.value, {
        now: 0,
        timeZone: "UTC",
      });

      const withPolyfill = resolveCondition(
        checked.value,
        { now: 0, timeZone: "UTC" },
        { temporal: injected }
      );

      assert.strictEqual(
        missing.ok ? undefined : missing.error.issues[0]?.reason,
        "temporalUnavailable"
      );
      assert.isTrue(withPolyfill.ok);
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, "Temporal", descriptor);
      }
    }
  });
});
