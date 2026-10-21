import { assert, describe, it } from "@effect/vitest";
import {
  assert as checkProperty,
  double,
  jsonValue,
  property,
} from "fast-check";

import { getOrThrow } from "../src/field-error.ts";
import type { Decoded } from "../src/field-error.ts";
import { isJsonValue } from "../src/json-value.ts";
import {
  checkJsonValue,
  checkNumberLiteral,
  JSON_MAX_DEPTH,
  JSON_TRANSPORT_MAX_DEPTH,
  parseJson,
  stringifyJson,
} from "../src/json.ts";
import {
  compareJsonbKeys,
  jsonbEquals,
  jsonbKeys,
  utf8Length,
} from "../src/jsonb.ts";

const reason = (decoded: Decoded<unknown>): string =>
  decoded.ok ? "ok" : decoded.error.reason;

describe(parseJson, () => {
  it("parses RFC 8259 JSON", () => {
    assert.deepStrictEqual(
      getOrThrow(
        parseJson(
          ' {"a": [1, -2.5e-3, true, false, null], "b\\u00e9": "x\\ny\\"\\\\\\/"} '
        )
      ),
      { a: [1, -0.0025, true, false, null], bé: 'x\ny"\\/' }
    );
    assert.strictEqual(getOrThrow(parseJson('"\\ud83d\\ude00"')), "😀");
    assert.strictEqual(getOrThrow(parseJson("-0")), 0);
    assert.isTrue(Object.is(getOrThrow(parseJson("-0")), 0));
  });

  it("refuses malformed text", () => {
    for (const text of [
      "",
      " ",
      "01",
      "1.",
      ".5",
      "+1",
      "[1,]",
      '{"a":1,}',
      "{a:1}",
      "'a'",
      '"\t"',
      "nul",
      "[1] 2",
      '"\\x"',
      '"\\u12"',
      "1e",
      "--1",
      "NaN",
      "Infinity",
      "[",
      '{"a"',
      '{"a":}',
    ]) {
      assert.strictEqual(reason(parseJson(text)), "invalidJson", text);
    }
  });

  it("refuses duplicates, NUL, lone surrogates, deep nesting and unsafe numbers", () => {
    assert.strictEqual(
      reason(parseJson('{"a":1,"\\u0061":2}')),
      "duplicateKey"
    );
    assert.strictEqual(reason(parseJson('"\\u0000"')), "nulCharacter");
    assert.strictEqual(reason(parseJson('{"\\u0000":1}')), "nulCharacter");
    assert.strictEqual(reason(parseJson('"\\ud800"')), "notWellFormed");
    assert.strictEqual(reason(parseJson('"\uD800"')), "notWellFormed");
    assert.strictEqual(
      reason(
        parseJson(
          `${"[".repeat(JSON_TRANSPORT_MAX_DEPTH + 1)}${"]".repeat(JSON_TRANSPORT_MAX_DEPTH + 1)}`
        )
      ),
      "tooDeep"
    );
    assert.strictEqual(
      reason(
        checkJsonValue(
          getOrThrow(
            parseJson(
              `${"[".repeat(JSON_MAX_DEPTH + 1)}${"]".repeat(JSON_MAX_DEPTH + 1)}`
            )
          )
        )
      ),
      "tooDeep"
    );
    assert.strictEqual(reason(parseJson("1e400")), "inexactNumber");
    assert.strictEqual(reason(parseJson("1e-400")), "inexactNumber");
    assert.strictEqual(reason(parseJson("9007199254740992")), "unsafeInteger");
    assert.strictEqual(reason(parseJson("1e300")), "unsafeInteger");
    assert.strictEqual(
      getOrThrow(parseJson("9007199254740991")),
      Number.MAX_SAFE_INTEGER
    );
  });

  it("keeps __proto__ an ordinary key", () => {
    const parsed = getOrThrow(parseJson('{"__proto__": {"polluted": true}}'));

    assert.deepStrictEqual(Object.keys(parsed ?? {}), ["__proto__"]);
    assert.isFalse(Object.hasOwn(Object.prototype, "polluted"));
  });

  it("accepts a number literal exactly when it denotes its double", () => {
    assert.strictEqual(getOrThrow(checkNumberLiteral("0.1")), 0.1);
    assert.strictEqual(getOrThrow(checkNumberLiteral("1.0")), 1);
    assert.strictEqual(getOrThrow(checkNumberLiteral("100e-2")), 1);
    assert.strictEqual(
      getOrThrow(checkNumberLiteral("0.30000000000000004")),
      0.1 + 0.2
    );
    assert.strictEqual(getOrThrow(checkNumberLiteral("5e-324")), 5e-324);
    assert.strictEqual(
      reason(checkNumberLiteral("0.30000000000000003")),
      "inexactNumber"
    );
    assert.strictEqual(
      reason(checkNumberLiteral("0.1000000000000000055511151231257827")),
      "inexactNumber"
    );
    checkProperty(
      property(double({ noDefaultInfinity: true, noNaN: true }), (value) => {
        const unsafe = Number.isInteger(value) && !Number.isSafeInteger(value);

        assert.strictEqual(
          checkNumberLiteral(JSON.stringify(value)).ok,
          !unsafe
        );
      })
    );
  });

  it("round-trips generated JSON through stringifyJson", () => {
    checkProperty(
      property(jsonValue(), (value) => {
        if (!isJsonValue(value)) {
          return;
        }

        const checked = checkJsonValue(value);

        if (!checked.ok) {
          return;
        }

        const text = stringifyJson(checked.value);
        const parsed = getOrThrow(parseJson(text));

        assert.isTrue(jsonbEquals(parsed, checked.value));
        assert.strictEqual(stringifyJson(parsed), text);
      })
    );
  });
});

describe("jsonb order and equality", () => {
  it("orders keys by UTF-8 length, then bytes", () => {
    assert.deepStrictEqual(
      jsonbKeys({
        "": 0,
        "10": 4,
        "2": 3,
        aa: 5,
        b: 1,
        é: 6,
        "\uFFFF": 7,
        "😀": 8,
      }),
      ["", "2", "b", "10", "aa", "é", "\uFFFF", "😀"]
    );
    assert.isBelow(compareJsonbKeys("\uFFFF", "😀"), 0);
    assert.isBelow(compareJsonbKeys("\uE000a", "😀"), 0);
    assert.strictEqual(utf8Length("aé€😀"), 1 + 2 + 3 + 4);
  });

  it("writes canonical text in jsonb key order", () => {
    assert.strictEqual(
      stringifyJson({ "10": 1, "9": 2, aa: [true], b: null }),
      '{"9":2,"b":null,"10":1,"aa":[true]}'
    );
  });

  it("compares like jsonb", () => {
    assert.isTrue(
      jsonbEquals({ a: 1, b: [1, { c: null }] }, { a: 1, b: [1, { c: null }] })
    );
    assert.isFalse(jsonbEquals([1, 2], [2, 1]));
    assert.isFalse(jsonbEquals({ a: null }, {}));
    assert.isFalse(jsonbEquals(1, [1]));
    assert.isFalse(jsonbEquals("1", 1));
    assert.isTrue(jsonbEquals(-0, 0));
  });

  it("checkJsonValue refuses what jsonb or JavaScript cannot agree on", () => {
    assert.strictEqual(reason(checkJsonValue(2 ** 53)), "unsafeInteger");
    assert.strictEqual(
      reason(checkJsonValue(Number.POSITIVE_INFINITY)),
      "wrongJsonType"
    );
    assert.strictEqual(reason(checkJsonValue({ "a\0": 1 })), "nulCharacter");
    assert.strictEqual(reason(checkJsonValue(["\uDC00"])), "notWellFormed");
    assert.isFalse(isJsonValue(new Date()));
    assert.isFalse(isJsonValue({ a: new Map() }));
    assert.isFalse(isJsonValue([1n]));
    assert.isTrue(isJsonValue({ a: [1, "b", null, { c: false }] }));
  });
});
