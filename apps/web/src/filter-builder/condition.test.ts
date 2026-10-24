import { DatePicker } from "@foldkit/ui";
import type { Expr, Value } from "@std/conditions/ast";
import { parseCondition } from "@std/conditions/syntax-parse";
import { printCondition } from "@std/conditions/syntax-print";
import { formatDateTime } from "@std/values/date-time";
import { formatDecimal, makeDecimal } from "@std/values/decimal";
import { comparisonClass, isOrdered } from "@std/values/field-type";
import type { FieldKind } from "@std/values/field-type";
import { convertNeedle, convertSingleLineText } from "@std/values/text";
import { Option, Result } from "effect";
import {
  array as arrayOf,
  assert as assertProperty,
  bigInt,
  boolean,
  constant,
  constantFrom,
  date as dateOf,
  integer,
  letrec,
  nat,
  oneof,
  property,
  record as recordOf,
  string as stringOf,
  tuple,
  uuid,
} from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";

import { tableClassView } from "../domain/table-view.ts";
import {
  ASSET_FIELDS,
  USER_FIELDS,
  assetTable,
  fixtureTables,
} from "../table-fixture.ts";
import {
  conditionToExpr,
  followedReferences,
  literalFromText,
  loadCondition,
  parseOffset,
  toCondition,
  pickerIdOf,
} from "./condition.ts";
import type { ConditionScope, Loaded } from "./condition.ts";
import { Condition, Operand } from "./model.ts";

const scope: ConditionScope = { table: "acme.asset", tables: fixtureTables };

const view = tableClassView(fixtureTables);

const loadContext = {
  ...scope,
  builderId: "filter",
  firstNodeId: 1,
  today: { day: 22, month: 10, year: 2026 },
};

const print = (expr: Expr) =>
  printCondition(expr, { classId: "acme.asset", field: view.field });

const parse = (text: string) =>
  parseCondition(text, {
    classId: "acme.asset",
    resolveName: (classId, name) => view.fieldByName?.(classId, name),
  });

const fieldNamed = (name: string) => {
  const found = assetTable.fields.find((field) => field.name === name);

  if (found === undefined) {
    throw new RangeError(name);
  }

  return found;
};

// ARBITRARIES: canonical ASTs of the shapes the builder shows.

const singleLineText = stringOf({
  maxLength: 12,
  minLength: 1,
  unit: "grapheme",
})
  .map(convertSingleLineText)
  .filter((converted) => converted.ok && converted.value !== null)
  .map((converted) => (converted.ok ? (converted.value ?? "x") : "x"));

const needleText = stringOf({ maxLength: 12, minLength: 1, unit: "grapheme" })
  .map(convertNeedle)
  .filter((converted) => converted.ok && converted.value !== "")
  .map((converted) => (converted.ok ? converted.value : "x"));

const isoDate = dateOf({
  max: new Date("9999-12-31T00:00:00.000Z"),
  min: new Date("0001-01-01T00:00:00.000Z"),
  noInvalidDate: true,
}).map((date) => date.toISOString().slice(0, "YYYY-MM-DD".length));

const minuteInstant = integer({ max: 4_000_000_000, min: -30_000_000 }).map(
  (minutes) => formatDateTime(minutes * 60_000)
);

const uuidText = uuid().map((text) => text.toLowerCase());

const offset = integer({ max: 1000, min: -1000 }).map((n) => (n === 0 ? 0 : n));

const decimalText = tuple(
  bigInt({ max: 10n ** 20n, min: -(10n ** 20n) }),
  nat({ max: 6 })
).map(([coefficient, scale]) => formatDecimal(makeDecimal(coefficient, scale)));

const literalOf = new Map<string, Arbitrary<Value>>(
  Object.entries({
    [ASSET_FIELDS.active]: boolean().map((value) => ({ value })),
    [ASSET_FIELDS.checkedAt]: minuteInstant.map((value) => ({ value })),
    [ASSET_FIELDS.cost]: decimalText.map((value) => ({ value })),
    [ASSET_FIELDS.dockedTo]: uuidText.map((value) => ({ value })),
    [ASSET_FIELDS.name]: singleLineText.map((value) => ({ value })),
    [ASSET_FIELDS.notes]: singleLineText.map((value) => ({ value })),
    [ASSET_FIELDS.owner]: uuidText.map((value) => ({ value })),
    [ASSET_FIELDS.purchasedOn]: isoDate.map((value) => ({ value })),
    [ASSET_FIELDS.serial]: bigInt({
      max: 2n ** 63n - 1n,
      min: -(2n ** 63n),
    }).map((value) => ({ value: value.toString() })),
    [ASSET_FIELDS.sizeInches]: integer({
      max: 2_147_483_647,
      min: -2_147_483_648,
    }).map((value) => ({ value: value === 0 ? 0 : value })),
    [ASSET_FIELDS.status]: constantFrom("in_use", "lost", "scrapped").map(
      (value) => ({ value })
    ),
    [ASSET_FIELDS.tag]: uuidText.map((value) => ({ value })),
    [USER_FIELDS.name]: singleLineText.map((value) => ({ value })),
    [USER_FIELDS.login]: singleLineText.map((value) => ({ value })),
    [USER_FIELDS.active]: boolean().map((value) => ({ value })),
  })
);

const rightOf = (fieldId: string, kind: string): Arbitrary<Value> => {
  const literal = literalOf.get(fieldId) ?? constant({ value: "x" });

  if (fieldId === ASSET_FIELDS.owner) {
    return oneof(literal, constant({ ctx: "me" as const }));
  }

  if (kind === "date") {
    return oneof(
      literal,
      recordOf(
        {
          offset,
          rel: constant("today" as const),
          unit: constantFrom("day", "week", "month", "year"),
        },
        { noNullPrototype: true }
      )
    );
  }

  if (kind === "dateTime") {
    return oneof(
      literal,
      constant({ ctx: "now" as const }),
      recordOf(
        {
          offset,
          rel: constant("today" as const),
          unit: constantFrom("day", "week", "month", "year"),
        },
        { noNullPrototype: true }
      ),
      recordOf(
        {
          offset,
          rel: constant("now" as const),
          unit: constantFrom("minute", "hour", "day", "week", "month", "year"),
        },
        { noNullPrototype: true }
      )
    );
  }

  return literal;
};

const paths: readonly (readonly [readonly string[], string, FieldKind])[] = [
  ...assetTable.fields
    .filter((field) => field.type.kind !== "json")
    .map((field) => [[field.id], field.id, field.type.kind] as const),
  [[ASSET_FIELDS.owner, USER_FIELDS.name], USER_FIELDS.name, "text"],
  [[ASSET_FIELDS.owner, USER_FIELDS.active], USER_FIELDS.active, "boolean"],
  [[ASSET_FIELDS.dockedTo, ASSET_FIELDS.cost], ASSET_FIELDS.cost, "decimal"],
  [
    [ASSET_FIELDS.dockedTo, ASSET_FIELDS.purchasedOn],
    ASSET_FIELDS.purchasedOn,
    "date",
  ],
];

const atom: Arbitrary<Expr> = constantFrom(...paths).chain(
  ([path, fieldId, kind]) => {
    const left = { path: [...path] };

    const choices: Arbitrary<Expr>[] = [
      constantFrom("empty" as const, "notEmpty" as const).map((op) => ({
        arg: left,
        op,
      })),
    ];

    if (kind === "boolean") {
      choices.length = 0;
    }

    if (comparisonClass(kind) !== null) {
      choices.push(
        tuple(
          constantFrom("eq" as const, "ne" as const),
          rightOf(fieldId, kind)
        ).map(([op, right]) => ({ left, op, right })),
        tuple(
          constantFrom("in" as const, "notIn" as const),
          arrayOf(literalOf.get(fieldId) ?? constant({ value: "x" }), {
            maxLength: 3,
            minLength: 1,
          })
        ).map(([op, right]) => ({ left, op, right }))
      );
    }

    if (isOrdered(kind)) {
      choices.push(
        tuple(
          constantFrom(
            "lt" as const,
            "le" as const,
            "gt" as const,
            "ge" as const
          ),
          rightOf(fieldId, kind)
        ).map(([op, right]) => ({ left, op, right }))
      );
    }

    if (kind === "text" || kind === "longText") {
      choices.push(
        tuple(
          constantFrom(
            "contains" as const,
            "notContains" as const,
            "startsWith" as const,
            "endsWith" as const
          ),
          needleText
        ).map(([op, right]) => ({ left, op, right }))
      );
    }

    if (kind === "date" || kind === "dateTime") {
      choices.push(
        recordOf(
          {
            offset,
            unit: constantFrom("day", "week", "month", "quarter", "year"),
          },
          { noNullPrototype: true }
        ).map((period) => ({ left, op: "inPeriod" as const, period }))
      );
    }

    return oneof(...choices);
  }
);

const condition: Arbitrary<Expr> = letrec<{ expr: Expr }>((tie) => ({
  expr: oneof(
    { depthSize: "small", withCrossShrink: true },
    atom,
    tuple(
      constantFrom("and" as const, "or" as const),
      arrayOf(tie("expr"), { maxLength: 3, minLength: 1 })
    ).map(([op, args]) => ({ args, op })),
    tie("expr").map((arg) => ({ arg, op: "not" as const }))
  ),
})).expr;

/**
 * The builder state an AST loads into.
 *
 * @param expr - A condition the builder shows.
 * @returns The builder's tree.
 */
const builderStateOf = (expr: Expr) =>
  Result.getOrThrowWith(
    Result.map(loadCondition(expr, loadContext), (loaded) => loaded.root),
    (problem) => new Error(problem.message)
  );

/**
 * Prints a condition with names and parses the text back.
 *
 * @param expr - The condition.
 * @returns The parsed AST, or the printer's or parser's message.
 */
const printAndParse = (expr: Expr): Result.Result<Expr, string> => {
  const printed = print(expr);

  if (!printed.ok) {
    return Result.fail(printed.error.message);
  }

  const parsed = parse(printed.value);

  return parsed.ok
    ? Result.succeed(parsed.value.expr)
    : Result.fail(parsed.error.message);
};

describe("filter builder and the condition AST", () => {
  it("loads every AST it shows and gives it back unchanged", () => {
    assertProperty(
      property(condition, (expr) => {
        const loaded = loadCondition(expr, loadContext);

        expect(
          Result.map((state: Loaded) => toCondition(state.root, scope))(loaded)
        ).toStrictEqual(Result.succeed(Result.succeed(expr)));
      }),
      { numRuns: 500 }
    );
  });

  it("prints a builder state that parses back to the same AST", () => {
    assertProperty(
      property(condition, (expr) => {
        const built = toCondition(builderStateOf(expr), scope);

        expect(Result.isSuccess(built)).toBeTruthy();
        expect(Result.flatMap(printAndParse)(built)).toStrictEqual(built);
      }),
      { numRuns: 500 }
    );
  });

  it("does not load what it cannot show", () => {
    const refused: readonly Expr[] = [
      { op: "true" },
      {
        left: { path: [ASSET_FIELDS.cost] },
        op: "eq",
        right: { path: [ASSET_FIELDS.sizeInches] },
      },
      { arg: { path: [ASSET_FIELDS.name] }, op: "changed" },
      {
        left: { path: [ASSET_FIELDS.owner] },
        op: "in",
        right: { ctx: "myGroups" },
      },
      {
        left: { path: ["00000000-0000-4000-8000-0000000000ff"] },
        op: "eq",
        right: { value: "x" },
      },
      {
        left: { path: [ASSET_FIELDS.checkedAt] },
        op: "eq",
        right: { value: "2026-10-22T10:15:30.000Z" },
      },
      {
        left: { image: "previous", path: [ASSET_FIELDS.name] },
        op: "eq",
        right: { value: "x" },
      },
    ];

    expect(
      refused.filter((expr) =>
        Result.isSuccess(loadCondition(expr, loadContext))
      )
    ).toStrictEqual([]);
  });

  it("converts typed literals to the field type's canonical JSON", () => {
    expect(literalFromText(fieldNamed("cost"), " 0012.50 ")).toStrictEqual(
      Result.succeed("12.50")
    );
    expect(literalFromText(fieldNamed("serial_number"), "-0")).toStrictEqual(
      Result.succeed("0")
    );
    expect(literalFromText(fieldNamed("size_inches"), "27")).toStrictEqual(
      Result.succeed(27)
    );
    expect(literalFromText(fieldNamed("name"), "  Laptop  ")).toStrictEqual(
      Result.succeed("Laptop")
    );
    expect(
      literalFromText(fieldNamed("tag"), "01920C4E-7A3B-7C1D-9A2E-3F4B5C6D7E8F")
    ).toStrictEqual(Result.succeed("01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f"));
  });

  it("refuses typed literals that do not convert", () => {
    const refused = [
      literalFromText(fieldNamed("size_inches"), "1.5"),
      literalFromText(fieldNamed("name"), "   "),
      literalFromText(fieldNamed("size_inches"), "3000000000"),
      literalFromText(fieldNamed("status"), "unknown_key"),
    ];

    expect(refused.every(Result.isFailure)).toBeTruthy();
  });

  it("sends a date-time as the UTC instant of the picked date and time", () => {
    const instant = conditionToExpr(
      Condition({
        id: 1,
        operand: Operand.Instant({
          maybeDate: Option.some({ day: 25, month: 10, year: 2026 }),
          picker: DatePicker.init({
            id: pickerIdOf(loadContext.builderId, 1),
            today: loadContext.today,
          }),
          time: "09:30",
        }),
        operator: "ge",
        path: [ASSET_FIELDS.checkedAt],
      }),
      scope
    );

    expect(instant).toStrictEqual(
      Result.succeed({
        left: { path: [ASSET_FIELDS.checkedAt] },
        op: "ge",
        right: { value: "2026-10-25T09:30:00.000Z" },
      })
    );
  });

  it("reads offsets as whole numbers within the checker's limit", () => {
    expect(parseOffset(" -0 ")).toStrictEqual(Result.succeed(0));
    expect(parseOffset("-7")).toStrictEqual(Result.succeed(-7));
    expect(
      [parseOffset("1.5"), parseOffset("100001")].every(Result.isFailure)
    ).toBeTruthy();
  });

  it("finds the references a condition follows", () => {
    expect(
      followedReferences({
        args: [
          {
            left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
            op: "eq",
            right: { value: "Bob" },
          },
          { arg: { path: [ASSET_FIELDS.dockedTo] }, op: "empty" },
        ],
        op: "or",
      })
    ).toStrictEqual(new Set([ASSET_FIELDS.owner]));
  });
});
