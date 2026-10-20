import { assert, describe, it } from "@effect/vitest";
import {
  assert as checkProperty,
  bigInt,
  integer,
  property,
  record,
} from "fast-check";

import {
  compareDecimals,
  decimalsEqual,
  fitDecimal,
  formatDecimal,
  integerDigits,
  makeDecimal,
  normalizeDecimal,
  parseDecimal,
  rescaleDecimal,
} from "../src/decimal.ts";
import { getOrThrow } from "../src/field-error.ts";

const decimals = record({
  coefficient: bigInt({ max: 10n ** 30n, min: -(10n ** 30n) }),
  scale: integer({ max: 20, min: 0 }),
}).map(({ coefficient, scale }) => makeDecimal(coefficient, scale));

const parse = (text: string) => getOrThrow(parseDecimal(text));

describe("decimal", () => {
  it("parses and formats at the written scale", () => {
    assert.deepStrictEqual(parse("1.500"), makeDecimal(1500n, 3));
    assert.deepStrictEqual(parse("-0"), makeDecimal(0n, 0));
    assert.deepStrictEqual(parse("007.10"), makeDecimal(710n, 2));
    assert.strictEqual(formatDecimal(makeDecimal(-5n, 3)), "-0.005");
    assert.strictEqual(formatDecimal(makeDecimal(0n, 2)), "0.00");
    assert.strictEqual(formatDecimal(makeDecimal(123n, 0)), "123");
    assert.isFalse(parseDecimal("+1").ok);
    assert.isFalse(parseDecimal(".5").ok);
    assert.isFalse(parseDecimal("1,5").ok);
    assert.isFalse(parseDecimal("NaN").ok);
    assert.isFalse(parseDecimal("١").ok);
  });

  it("round-trips text exactly", () => {
    checkProperty(
      property(decimals, (value) => {
        const back = parse(formatDecimal(value));

        assert.strictEqual(back.coefficient, value.coefficient);
        assert.strictEqual(back.scale, value.scale);
      })
    );
  });

  it("rescales without rounding", () => {
    assert.deepStrictEqual(
      rescaleDecimal(parse("1.50"), 4),
      makeDecimal(15_000n, 4)
    );
    assert.deepStrictEqual(
      rescaleDecimal(parse("1.500"), 1),
      makeDecimal(15n, 1)
    );
    assert.strictEqual(rescaleDecimal(parse("1.005"), 2), undefined);
    assert.deepStrictEqual(
      normalizeDecimal(parse("10.500")),
      makeDecimal(105n, 1)
    );
    assert.deepStrictEqual(
      normalizeDecimal(parse("100")),
      makeDecimal(100n, 0)
    );
    checkProperty(
      property(decimals, integer({ max: 25, min: 0 }), (value, scale) => {
        const rescaled = rescaleDecimal(value, scale);

        if (rescaled !== undefined) {
          assert.isTrue(decimalsEqual(rescaled, value));
          assert.strictEqual(rescaled.scale, scale);
        }

        assert.isDefined(rescaleDecimal(value, value.scale + scale));
      })
    );
  });

  it("compares by value whatever the scale", () => {
    assert.isTrue(decimalsEqual(parse("1.5"), parse("1.50")));
    assert.strictEqual(compareDecimals(parse("-1.5"), parse("-1.49")), -1);
    assert.strictEqual(compareDecimals(parse("10"), parse("9.999")), 1);
    checkProperty(
      property(decimals, decimals, (left, right) => {
        const scale = Math.max(left.scale, right.scale);
        const a = rescaleDecimal(left, scale)?.coefficient ?? 0n;
        const b = rescaleDecimal(right, scale)?.coefficient ?? 0n;
        const expected = Math.sign(Number(a - b));

        assert.strictEqual(compareDecimals(left, right), expected);
        assert.strictEqual(compareDecimals(right, left), -expected);
      })
    );
  });

  it("fits numeric(p, s) exactly or refuses", () => {
    assert.strictEqual(integerDigits(parse("0.99")), 0);
    assert.strictEqual(integerDigits(parse("-123.4")), 3);
    assert.deepStrictEqual(
      getOrThrow(fitDecimal(parse("12345678.9"), 10, 2)),
      makeDecimal(1_234_567_890n, 2)
    );
    assert.isFalse(fitDecimal(parse("123456789"), 10, 2).ok);
    assert.isFalse(fitDecimal(parse("0.001"), 10, 2).ok);
    assert.isTrue(fitDecimal(parse("0.99"), 2, 2).ok);
    assert.isFalse(fitDecimal(parse("1"), 2, 2).ok);
  });
});
