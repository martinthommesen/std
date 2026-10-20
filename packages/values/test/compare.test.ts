import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  comparableValue,
  compareValues,
  storedEquals,
  typeEquals,
} from "../src/compare.ts";
import type { ComparableValue } from "../src/compare.ts";
import { parseDate } from "../src/date.ts";
import { parseDecimal } from "../src/decimal.ts";
import { getOrThrow } from "../src/field-error.ts";
import type { Decoded } from "../src/field-error.ts";
import {
  comparisonClass,
  FIELD_KINDS,
  FieldTypeSchema,
  isOrdered,
  parameterCast,
  postgresColumn,
} from "../src/field-type.ts";
import type { FieldType } from "../src/field-type.ts";
import {
  convertLiteral,
  convertNeedleLiteral,
  convertNumberText,
} from "../src/literal.ts";

const reason = (decoded: Decoded<unknown>): string =>
  decoded.ok ? "ok" : decoded.error.reason;

const isFieldType = Schema.is(FieldTypeSchema);

const integer = (value: number): ComparableValue => ({
  kind: "integer",
  value,
});

const bigInteger = (value: bigint): ComparableValue => ({
  kind: "bigInteger",
  value,
});

const decimal = (text: string): ComparableValue => ({
  kind: "decimal",
  value: getOrThrow(parseDecimal(text)),
});

const text = (value: string, caseSensitive = false): ComparableValue => ({
  caseSensitive,
  kind: "text",
  value,
});

describe("type equality and order", () => {
  it("compares the numeric class exactly across kinds", () => {
    assert.isTrue(typeEquals(decimal("1.5"), decimal("1.50")));
    assert.isTrue(typeEquals(integer(2), decimal("2.000")));
    assert.isTrue(
      typeEquals(
        bigInteger(9_007_199_254_740_993n),
        decimal("9007199254740993.0")
      )
    );
    assert.isFalse(
      typeEquals(
        bigInteger(9_007_199_254_740_993n),
        integer(9_007_199_254_740_992)
      )
    );
    assert.strictEqual(compareValues(integer(3), decimal("2.99")), 1);
    assert.strictEqual(compareValues(bigInteger(-1n), decimal("-0.5")), -1);
  });

  it("compares text by key, each side with its own case setting", () => {
    assert.isTrue(typeEquals(text("Straße"), text("STRASSE")));
    assert.isFalse(typeEquals(text("i"), text("İ")));
    assert.isFalse(typeEquals(text("Alice", true), text("alice", true)));
    assert.isTrue(typeEquals(text("alice", true), text("ALICE")));
    assert.strictEqual(compareValues(text("a"), text("b")), undefined);
  });

  it("compares the other classes by value, and never across classes", () => {
    const day = getOrThrow(parseDate("2024-02-29"));

    assert.isTrue(
      typeEquals(
        { kind: "choice", value: "open" },
        { kind: "choice", value: "open" }
      )
    );
    assert.isFalse(
      typeEquals(
        { kind: "choice", value: "Open" },
        { kind: "choice", value: "open" }
      )
    );
    assert.isTrue(
      typeEquals(
        { kind: "reference", value: "a" },
        { kind: "uuid", value: "a" }
      )
    );
    assert.isFalse(typeEquals({ kind: "choice", value: "a" }, text("a")));
    assert.isFalse(
      typeEquals({ kind: "date", value: day }, { kind: "dateTime", value: 0 })
    );
    assert.strictEqual(
      compareValues(
        { kind: "date", value: day },
        { kind: "dateTime", value: 0 }
      ),
      undefined
    );
    assert.strictEqual(
      compareValues(
        { kind: "dateTime", value: 5 },
        { kind: "dateTime", value: 7 }
      ),
      -1
    );
    assert.isFalse(
      typeEquals(
        { kind: "boolean", value: true },
        { kind: "boolean", value: false }
      )
    );
  });

  it("tags stored values with their class", () => {
    assert.deepStrictEqual(
      comparableValue({ caseSensitive: true, kind: "text" }, "A"),
      text("A", true)
    );
    assert.deepStrictEqual(comparableValue({ kind: "integer" }, 1), integer(1));
    assert.strictEqual(comparableValue({ kind: "json" }, 1), undefined);
    assert.strictEqual(comparableValue({ kind: "integer" }, "1"), undefined);
  });

  it("stored equality is exact", () => {
    assert.isFalse(storedEquals("text", "alice", "Alice"));
    assert.isTrue(storedEquals("text", null, null));
    assert.isFalse(storedEquals("text", null, ""));
    assert.isTrue(
      storedEquals(
        "decimal",
        getOrThrow(parseDecimal("1.50")),
        getOrThrow(parseDecimal("1.50"))
      )
    );
    assert.isTrue(storedEquals("bigInteger", 5n, 5n));
  });
});

describe("field types", () => {
  it("validates settings with the schema", () => {
    const valid: unknown[] = [
      { kind: "text" },
      { caseSensitive: true, kind: "text", maxLength: 4000 },
      { kind: "longText", maxLength: 1_000_000 },
      { kind: "decimal", max: "99.99", min: "-99.99", precision: 4, scale: 2 },
      { kind: "bigInteger", max: "9223372036854775807", min: "-1" },
      { kind: "integer", max: 10, min: -10 },
      {
        kind: "reference",
        targetClassId: "01920c4e-0000-7000-8000-000000000001",
      },
      { kind: "condition", profile: "accessRule" },
    ];

    const invalid: unknown[] = [
      { kind: "text", maxLength: 4001 },
      { kind: "text", maxLength: 0 },
      { kind: "decimal", precision: 39, scale: 0 },
      { kind: "decimal", precision: 4, scale: 5 },
      { kind: "decimal", max: "100", precision: 4, scale: 2 },
      { kind: "decimal", max: "1.001", precision: 4, scale: 2 },
      { kind: "integer", max: -1, min: 1 },
      { kind: "integer", max: 2 ** 31 },
      { kind: "bigInteger", max: "9223372036854775808" },
      { kind: "bigInteger", max: "1", min: "2" },
      { kind: "reference", targetClassId: "X" },
      { kind: "condition", profile: "other" },
      { kind: "duration" },
    ];

    for (const type of valid) {
      assert.isTrue(isFieldType(type), JSON.stringify(type));
    }

    for (const type of invalid) {
      assert.isFalse(isFieldType(type), JSON.stringify(type));
    }
  });

  it("maps every kind to a column, a cast and a class", () => {
    const decimalType: FieldType = { kind: "decimal", precision: 10, scale: 2 };
    const textColumn = postgresColumn({ kind: "text", maxLength: 80 });

    assert.strictEqual(FIELD_KINDS.length, 15);
    assert.strictEqual(postgresColumn(decimalType).sqlType, "numeric(10,2)");
    assert.strictEqual(
      textColumn.check?.('"name"'),
      'char_length("name") <= 80'
    );
    assert.deepStrictEqual(postgresColumn({ kind: "boolean" }), {
      defaultExpression: "false",
      notNull: true,
      sqlType: "boolean",
    });
    assert.strictEqual(
      postgresColumn({ kind: "dateTime" }).sqlType,
      "timestamptz(3)"
    );
    assert.strictEqual(postgresColumn({ kind: "secret" }).sqlType, "bytea");
    assert.strictEqual(parameterCast("decimal"), "numeric");
    assert.strictEqual(
      comparisonClass("bigInteger"),
      comparisonClass("decimal")
    );
    assert.strictEqual(comparisonClass("reference"), comparisonClass("uuid"));
    assert.strictEqual(comparisonClass("json"), null);
    assert.isTrue(isOrdered("date"));
    assert.isFalse(isOrdered("text"));
  });
});

describe("condition literals", () => {
  it("convert under the type's rules, not the field's settings", () => {
    assert.deepStrictEqual(
      getOrThrow(convertLiteral("decimal", "1.005")),
      getOrThrow(parseDecimal("1.005"))
    );
    assert.strictEqual(
      reason(convertLiteral("integer", 2_147_483_648)),
      "outOfRange"
    );
    assert.strictEqual(reason(convertLiteral("decimal", 1.5)), "wrongJsonType");
    assert.strictEqual(
      getOrThrow(convertLiteral("text", "x".repeat(4000))),
      "x".repeat(4000)
    );
    assert.strictEqual(
      reason(convertLiteral("text", "x".repeat(4001))),
      "tooLong"
    );
    assert.strictEqual(
      getOrThrow(convertLiteral("text", " Straße ")),
      "Straße"
    );
    assert.strictEqual(
      reason(convertLiteral("password", "x")),
      "notComparable"
    );
    assert.strictEqual(reason(convertLiteral("json", {})), "notComparable");
  });

  it("refuse text that converts to null, with a hint to use empty", () => {
    const refused = convertLiteral("text", "   ");

    assert.strictEqual(reason(refused), "emptyLiteral");
    assert.include(refused.ok ? "" : (refused.error.hint ?? ""), "empty");
  });

  it("allow retired choices", () => {
    const choices = { active: new Set(["open"]), retired: new Set(["legacy"]) };

    assert.strictEqual(
      getOrThrow(convertLiteral("choice", "legacy", { choices })),
      "legacy"
    );
    assert.strictEqual(
      reason(convertLiteral("choice", "gone", { choices })),
      "unknownChoice"
    );
  });

  it("convert number text without a JS number", () => {
    assert.strictEqual(
      getOrThrow(convertNumberText("bigInteger", "9007199254740993")),
      9_007_199_254_740_993n
    );
    assert.strictEqual(getOrThrow(convertNumberText("integer", "12.0")), 12);
    assert.strictEqual(
      reason(convertNumberText("integer", "12.5")),
      "notInteger"
    );
    assert.strictEqual(
      reason(convertNumberText("integer", "2147483648")),
      "outOfRange"
    );
    assert.strictEqual(reason(convertNumberText("text", "1")), "wrongJsonType");
  });

  it("convert needles with steps 1 and 2 only", () => {
    assert.strictEqual(
      getOrThrow(convertNeedleLiteral("contains", "text", " e\u0301")),
      " é"
    );
    assert.strictEqual(
      reason(convertNeedleLiteral("contains", "text", "")),
      "emptyNeedle"
    );
    assert.strictEqual(
      getOrThrow(convertNeedleLiteral("startsWith", "longText", "")),
      ""
    );
    assert.strictEqual(
      reason(convertNeedleLiteral("endsWith", "text", "a\0")),
      "nulCharacter"
    );
  });
});
