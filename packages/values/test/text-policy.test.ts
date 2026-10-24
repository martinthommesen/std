import { assert, describe, it } from "@effect/vitest";

import { decodeIn, encodeOut } from "../src/codec.ts";
import { storedEquals } from "../src/compare.ts";
import { getOrThrow } from "../src/field-error.ts";
import type { FieldTypeOf } from "../src/field-type.ts";
import { convertLiteral, convertNeedleLiteral } from "../src/literal.ts";
import { planUpdate } from "../src/write.ts";

const prose: FieldTypeOf<"longText"> = {
  kind: "longText",
  textPolicy: "freeText",
};

const title: FieldTypeOf<"text"> = { kind: "text", textPolicy: "freeText" };

describe("text-policy", () => {
  it("preserves accepted Unicode, whitespace and line endings in writes and literals", () => {
    for (const value of [
      "",
      " \t\u00A0\uFEFF",
      " e\u0301 ",
      "a\r\nb\rc\n",
      "😀",
      "\u0378",
    ]) {
      const decoded = getOrThrow(decodeIn(prose, value));
      assert.strictEqual(decoded, value);
      assert.strictEqual(encodeOut(prose, decoded), value);
      assert.strictEqual(getOrThrow(convertLiteral(prose, value)), value);

      if (value !== "") {
        assert.strictEqual(
          getOrThrow(convertNeedleLiteral("contains", prose, value)),
          value
        );
      }
    }

    assert.strictEqual(
      getOrThrow(decodeIn(title, " \te\u0301\u00A0")),
      " \te\u0301\u00A0"
    );
  });

  it("keeps explicit null, empty text and an absent update distinct", () => {
    assert.strictEqual(getOrThrow(decodeIn(prose, null)), null);
    assert.strictEqual(getOrThrow(decodeIn(prose, "")), "");
    assert.deepStrictEqual(getOrThrow(planUpdate(prose, { present: false })), {
      action: "keep",
    });
    assert.deepStrictEqual(
      getOrThrow(planUpdate(prose, { json: null, present: true })),
      { action: "set", source: "payload", value: null }
    );
  });

  it("retains identifier conversion and single-line repertoire validation", () => {
    assert.strictEqual(
      getOrThrow(decodeIn({ kind: "text" }, " e\u0301\t")),
      "é"
    );
    assert.strictEqual(
      getOrThrow(decodeIn({ kind: "longText" }, "a\r\nb\r")),
      "a\nb\n"
    );
    assert.strictEqual(getOrThrow(decodeIn({ kind: "text" }, " \t")), null);

    for (const value of ["\u0000", "\uD800", "\n", "\r", "\u2028", "\u007F"]) {
      assert.isFalse(decodeIn(title, value).ok);
    }
  });

  it("counts the raw accepted scalar and reports the maximum and requested count", () => {
    const refused = decodeIn({ ...title, maxLength: 1 }, "e\u0301");
    assert.isFalse(refused.ok);

    if (!refused.ok) {
      assert.strictEqual(refused.error.reason, "tooLong");
      assert.include(refused.error.message, "maxLength=1");
      assert.include(refused.error.message, "asked for 2");
    }

    assert.strictEqual(
      getOrThrow(decodeIn({ ...title, maxLength: 1 }, "😀")),
      "😀"
    );
  });

  it("validates non-blank prose independently of preservation and literal matching", () => {
    const requiredProse = { ...prose, nonBlank: true };

    for (const value of ["", " \t\r\n\u00A0"]) {
      assert.isFalse(decodeIn({ ...prose, nonBlank: true }, value).ok);
      assert.strictEqual(
        getOrThrow(convertLiteral(requiredProse, value)),
        value
      );
    }

    assert.strictEqual(
      getOrThrow(decodeIn({ ...prose, nonBlank: true }, " text\r\n")),
      " text\r\n"
    );
  });

  it("makes scalar changes observable without changing exact no-op equality", () => {
    assert.isTrue(
      storedEquals(
        "longText",
        "e\u0301\r\n",
        getOrThrow(decodeIn(prose, "e\u0301\r\n"))
      )
    );
    assert.isFalse(
      storedEquals(
        "longText",
        "é\n",
        getOrThrow(decodeIn(prose, "e\u0301\r\n"))
      )
    );
  });
});
