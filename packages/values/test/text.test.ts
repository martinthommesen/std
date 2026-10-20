import { assert, describe, it } from "@effect/vitest";
import { assert as checkProperty, property, string } from "fast-check";

import { getOrThrow } from "../src/field-error.ts";
import {
  fold,
  isAssignedInFoldTableVersion,
  isFullyAssignedInFoldTableVersion,
  textKey,
  UNICODE_VERSION,
} from "../src/fold.ts";
import {
  escapeLike,
  likePattern,
  matchesPattern,
} from "../src/like-pattern.ts";
import {
  codePointLength,
  convertLongText,
  convertNeedle,
  convertSingleLineText,
} from "../src/text.ts";

const anyText = string({ maxLength: 40, unit: "binary" });
const LAST_C0 = 0x1f;
const TAB = 0x09;
const DELETE = 0x7f;
const LAST_C1 = 0x9f;
const SEPARATORS = new Set([0x20_28, 0x20_29]);

const isRefused = (codePoint: number): boolean => {
  const control =
    (codePoint <= LAST_C0 && codePoint !== TAB) ||
    (codePoint >= DELETE && codePoint <= LAST_C1);

  return control || SEPARATORS.has(codePoint);
};

const codePointsOf = (value: string): number[] => {
  const codePoints: number[] = [];

  for (const character of value) {
    codePoints.push(character.codePointAt(0) ?? 0);
  }

  return codePoints;
};

const hasRefusedCharacter = (value: string): boolean =>
  codePointsOf(value).some((codePoint) => isRefused(codePoint));

describe("write conversion", () => {
  it("single-line output is NFC, trimmed, free of controls, and idempotent", () => {
    checkProperty(
      property(anyText, (input) => {
        const converted = convertSingleLineText(input);

        if (!converted.ok || converted.value === null) {
          return;
        }

        const { value } = converted;

        assert.strictEqual(value, value.normalize("NFC"));
        assert.strictEqual(value, value.trim());
        assert.notStrictEqual(value, "");
        assert.isFalse(hasRefusedCharacter(value));
        assert.strictEqual(getOrThrow(convertSingleLineText(value)), value);
      })
    );
  });

  it("long text output is NFC with LF line ends, and idempotent", () => {
    checkProperty(
      property(anyText, (input) => {
        const converted = convertLongText(input);

        if (!converted.ok || converted.value === null) {
          return;
        }

        assert.notInclude(converted.value, "\r");
        assert.strictEqual(converted.value, converted.value.normalize("NFC"));
        assert.strictEqual(
          getOrThrow(convertLongText(converted.value)),
          converted.value
        );
      })
    );
  });

  it("needles are NFC but neither trimmed nor emptied", () => {
    assert.strictEqual(getOrThrow(convertNeedle(" e\u0301 ")), " é ");
    assert.strictEqual(getOrThrow(convertNeedle("")), "");
    assert.isFalse(convertNeedle("\uD800").ok);
  });

  it("counts code points like char_length", () => {
    assert.strictEqual(codePointLength("a😀b"), 3);
    assert.strictEqual(codePointLength("👩\u200D👩\u200D👧"), 5);
    assert.strictEqual(codePointLength(""), 0);
    checkProperty(
      property(string({ unit: "binary" }), (text) => {
        assert.strictEqual(codePointLength(text), codePointsOf(text).length);
      })
    );
  });
});

describe(fold, () => {
  it("is full case folding from Unicode 16.0.0, not toLowerCase", () => {
    assert.strictEqual(UNICODE_VERSION, "16.0.0");
    assert.strictEqual(fold("Straße"), "strasse");
    assert.strictEqual(fold("ẞ"), "ss");
    assert.strictEqual(fold("ﬁ"), "fi");
    assert.strictEqual(fold("ΣΑΣ"), "σασ");
    assert.strictEqual(fold("ς"), "σ");
    assert.strictEqual(fold("İ"), "i\u0307");
    assert.strictEqual(fold("ı"), "ı");
    assert.strictEqual(fold("É"), "é");
    assert.notStrictEqual(fold("é"), fold("e"));
    assert.strictEqual(fold("plain ascii 123"), "plain ascii 123");
    assert.strictEqual(fold("𐐀"), "𐐨");
  });

  it("is idempotent and maps per code point", () => {
    checkProperty(
      property(anyText, anyText, (left, right) => {
        assert.strictEqual(fold(fold(left)), fold(left));
        assert.strictEqual(fold(left + right), fold(left) + fold(right));
      })
    );
  });

  it("keys respect caseSensitive", () => {
    assert.strictEqual(textKey("Alice", false), "alice");
    assert.strictEqual(textKey("Alice", true), "Alice");
  });

  it("knows which code points the table's version assigns", () => {
    assert.isTrue(isAssignedInFoldTableVersion(0x41));
    assert.isTrue(isAssignedInFoldTableVersion(0x1_f6_00));
    assert.isFalse(isAssignedInFoldTableVersion(0x03_78));
    assert.isFalse(isAssignedInFoldTableVersion(0xfd_d0));
    assert.isFalse(isAssignedInFoldTableVersion(0x10_ff_ff));
    assert.isFalse(isAssignedInFoldTableVersion(0x11_00_00));
    assert.isTrue(isFullyAssignedInFoldTableVersion("Straße 😀"));
    assert.isFalse(isFullyAssignedInFoldTableVersion("a\u0378"));
  });
});

describe("LIKE patterns", () => {
  it("fold, escape and wrap the needle", () => {
    assert.strictEqual(
      escapeLike(String.raw`50%_off\now`),
      String.raw`50\%\_off\\now`
    );
    assert.strictEqual(likePattern("contains", "STRASSE", false), "%strasse%");
    assert.strictEqual(
      likePattern("startsWith", "A_b", true),
      String.raw`A\_b%`
    );
    assert.strictEqual(likePattern("endsWith", "%", false), String.raw`%\%`);
  });

  it("evaluate in TypeScript by key", () => {
    assert.isTrue(matchesPattern("contains", "Große Straße", "STRASSE", false));
    assert.isFalse(matchesPattern("contains", "Große Straße", "STRASSE", true));
    assert.isTrue(matchesPattern("startsWith", "ΣΑΣ", "σα", false));
    assert.isTrue(matchesPattern("endsWith", "Fiﬁ", "FI", false));
    assert.isFalse(matchesPattern("contains", "abc", "_", false));
  });
});
