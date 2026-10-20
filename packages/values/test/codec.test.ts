import { inspect } from "node:util";

import { assert, describe, it } from "@effect/vitest";
import { assert as checkProperty, bigInt, integer, property } from "fast-check";

import { decodeChoiceWrite, decodeIn, encodeOut } from "../src/codec.ts";
import { storedEquals } from "../src/compare.ts";
import { getOrThrow } from "../src/field-error.ts";
import type { Decoded } from "../src/field-error.ts";
import type { FieldType } from "../src/field-type.ts";
import type { JsonValue } from "../src/json-value.ts";
import { parseJson } from "../src/json.ts";
import { isPlaintext, secretState } from "../src/write-only.ts";
import { planCreate, planUpdate } from "../src/write.ts";

const TEXT: FieldType = { kind: "text" };
const LONG_TEXT: FieldType = { kind: "longText" };
const DECIMAL_10_2: FieldType = { kind: "decimal", precision: 10, scale: 2 };
const BIG_INTEGER: FieldType = { kind: "bigInteger" };
const DATE_TIME: FieldType = { kind: "dateTime" };
const DATE: FieldType = { kind: "date" };
const BOOLEAN: FieldType = { kind: "boolean" };
const JSON_TYPE: FieldType = { kind: "json" };
const PASSWORD: FieldType = { kind: "password" };

const TIME_ZONES = [
  "UTC",
  "America/New_York",
  "Asia/Kathmandu",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
];

const reason = (decoded: Decoded<unknown>): string =>
  decoded.ok ? "ok" : decoded.error.reason;

// decodeIn then encodeOut: what a write followed by a read returns.
const roundTrip = (type: FieldType, json: JsonValue): JsonValue => {
  const decoded = decodeIn(type, json);
  const value = getOrThrow(decoded);

  if (isPlaintext(value)) {
    return encodeOut(type, secretState(true));
  }

  return encodeOut(type, value);
};

const withTimeZone = (zone: string, run: () => void): void => {
  const previous = process.env.TZ;
  process.env.TZ = zone;

  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
};

describe("text", () => {
  it('stores "  " as null and NFD as NFC', () => {
    assert.strictEqual(getOrThrow(decodeIn(TEXT, "  ")), null);
    assert.strictEqual(getOrThrow(decodeIn(TEXT, "")), null);
    assert.strictEqual(getOrThrow(decodeIn(TEXT, "e\u0301té")), "été");
    assert.strictEqual(
      getOrThrow(decodeIn(TEXT, " \u00A0 trimmed\u3000 ")),
      "trimmed"
    );
  });

  it("refuses lone surrogates, U+0000 and line breaks in single-line text", () => {
    assert.strictEqual(reason(decodeIn(TEXT, "a\uD800b")), "notWellFormed");
    assert.strictEqual(reason(decodeIn(TEXT, "a\0b")), "nulCharacter");

    for (const breaking of [
      "a\nb",
      "a\rb",
      "a\u2028b",
      "a\u2029b",
      "a\u0085b",
      "a\u0007b",
      "a\u007Fb",
    ]) {
      assert.strictEqual(reason(decodeIn(TEXT, breaking)), "controlCharacter");
    }

    assert.strictEqual(getOrThrow(decodeIn(TEXT, "a\tb")), "a\tb");
  });

  it("required text refuses empty and spaces: both convert to null first", () => {
    for (const blank of ["", " ", "\t \u00A0"]) {
      assert.strictEqual(getOrThrow(decodeIn(TEXT, blank)), null);
    }
  });

  it("long text normalizes line ends and keeps spaces", () => {
    assert.strictEqual(
      getOrThrow(decodeIn(LONG_TEXT, " a\r\nb\rc\n ")),
      " a\nb\nc\n "
    );
    assert.strictEqual(getOrThrow(decodeIn(LONG_TEXT, " \r\n\t")), null);
    assert.strictEqual(reason(decodeIn(LONG_TEXT, "a\0")), "nulCharacter");
  });

  it("limits length in code points", () => {
    const astral = "😀".repeat(255);

    assert.strictEqual(getOrThrow(decodeIn(TEXT, astral)), astral);
    assert.strictEqual(reason(decodeIn(TEXT, `${astral}x`)), "tooLong");
    assert.strictEqual(
      reason(decodeIn({ kind: "text", maxLength: 3 }, "abcd")),
      "tooLong"
    );
    assert.strictEqual(reason(decodeIn(TEXT, 12)), "wrongJsonType");
  });
});

describe("decimal(10,2)", () => {
  it("refuses 1.005, returns 1.500 as 1.50, refuses JSON 1.5, returns -0 as 0.00", () => {
    assert.strictEqual(reason(decodeIn(DECIMAL_10_2, "1.005")), "inexactScale");
    assert.strictEqual(roundTrip(DECIMAL_10_2, "1.500"), "1.50");
    assert.strictEqual(reason(decodeIn(DECIMAL_10_2, 1.5)), "wrongJsonType");
    assert.strictEqual(roundTrip(DECIMAL_10_2, "-0"), "0.00");
    assert.strictEqual(roundTrip(DECIMAL_10_2, "-0.000"), "0.00");
    assert.strictEqual(roundTrip(DECIMAL_10_2, "7"), "7.00");
  });

  it("enforces precision, syntax and the 100-digit limit", () => {
    assert.strictEqual(roundTrip(DECIMAL_10_2, "99999999.99"), "99999999.99");
    assert.strictEqual(
      reason(decodeIn(DECIMAL_10_2, "100000000")),
      "outOfRange"
    );
    assert.strictEqual(reason(decodeIn(DECIMAL_10_2, "1e2")), "invalidFormat");
    assert.strictEqual(reason(decodeIn(DECIMAL_10_2, "1.")), "invalidFormat");
    assert.strictEqual(reason(decodeIn(DECIMAL_10_2, "")), "invalidFormat");
    assert.strictEqual(
      reason(decodeIn(DECIMAL_10_2, `0.${"0".repeat(100)}`)),
      "tooManyDigits"
    );
  });

  it("checks min and max", () => {
    const bounded: FieldType = {
      kind: "decimal",
      max: "10.00",
      min: "-1.5",
      precision: 10,
      scale: 2,
    };

    assert.strictEqual(reason(decodeIn(bounded, "-1.51")), "belowMinimum");
    assert.strictEqual(reason(decodeIn(bounded, "10.01")), "aboveMaximum");
    assert.strictEqual(roundTrip(bounded, "10"), "10.00");
  });

  it("round-trips every value at the field's scale", () => {
    checkProperty(
      property(
        bigInt({ max: 9_999_999_999n, min: -9_999_999_999n }),
        (coefficient) => {
          const negative = coefficient < 0n;

          const digits = (negative ? -coefficient : coefficient)
            .toString()
            .padStart(3, "0");

          const text = `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;

          assert.strictEqual(roundTrip(DECIMAL_10_2, text), text);
        }
      )
    );
  });
});

describe("big integer", () => {
  it('round-trips "9007199254740993" exactly and refuses the JSON number', () => {
    assert.strictEqual(
      roundTrip(BIG_INTEGER, "9007199254740993"),
      "9007199254740993"
    );
    assert.strictEqual(
      reason(decodeIn(BIG_INTEGER, 9_007_199_254_740_992)),
      "wrongJsonType"
    );
    assert.strictEqual(
      roundTrip(BIG_INTEGER, "-9223372036854775808"),
      "-9223372036854775808"
    );
    assert.strictEqual(
      reason(decodeIn(BIG_INTEGER, "9223372036854775808")),
      "outOfRange"
    );
    assert.strictEqual(roundTrip(BIG_INTEGER, "-0"), "0");
    assert.strictEqual(reason(decodeIn(BIG_INTEGER, "1.0")), "invalidFormat");
  });

  it("round-trips every int8", () => {
    checkProperty(
      property(bigInt({ max: 2n ** 63n - 1n, min: -(2n ** 63n) }), (value) => {
        assert.strictEqual(
          roundTrip(BIG_INTEGER, value.toString()),
          value.toString()
        );
      })
    );
  });
});

describe(integer, () => {
  it("accepts integral JSON numbers in int4 range", () => {
    const integerType: FieldType = { kind: "integer" };

    assert.strictEqual(roundTrip(integerType, 2_147_483_647), 2_147_483_647);
    assert.strictEqual(roundTrip(integerType, -0), 0);
    assert.strictEqual(roundTrip(integerType, 1), 1);
    assert.strictEqual(
      reason(decodeIn(integerType, 2_147_483_648)),
      "outOfRange"
    );
    assert.strictEqual(reason(decodeIn(integerType, 1.5)), "notInteger");
    assert.strictEqual(reason(decodeIn(integerType, "1")), "wrongJsonType");
    assert.strictEqual(
      reason(decodeIn({ kind: "integer", max: 5, min: 1 }, 0)),
      "belowMinimum"
    );
  });
});

describe("date-time", () => {
  it("normalizes offsets to Z, refuses four fraction digits and :60", () => {
    assert.strictEqual(
      roundTrip(DATE_TIME, "2026-10-20T10:15:30.123+02:00"),
      "2026-10-20T08:15:30.123Z"
    );
    assert.strictEqual(
      roundTrip(DATE_TIME, "2026-10-20T08:15:30Z"),
      "2026-10-20T08:15:30.000Z"
    );
    assert.strictEqual(
      roundTrip(DATE_TIME, "2026-10-20t08:15:30.1230000z"),
      "2026-10-20T08:15:30.123Z"
    );
    assert.strictEqual(
      roundTrip(DATE_TIME, "2026-10-19T23:45:30.5-08:30"),
      "2026-10-20T08:15:30.500Z"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2026-10-20T08:15:30.1234Z")),
      "subMillisecond"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2016-12-31T23:59:60Z")),
      "leapSecond"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2026-10-20T08:15:30")),
      "invalidDateTime"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2026-10-20 08:15:30Z")),
      "invalidDateTime"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2026-02-30T08:15:30Z")),
      "invalidDateTime"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "2026-10-20T24:00:00Z")),
      "invalidDateTime"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, "0001-01-01T00:30:00+01:00")),
      "outOfRange"
    );
    assert.strictEqual(
      reason(decodeIn(DATE_TIME, 1_760_000_000_000)),
      "wrongJsonType"
    );
  });

  it("round-trips every instant from 0001 to 9999 and matches Date", () => {
    checkProperty(
      property(
        integer({ max: 253_402_300_799_999, min: -62_135_596_800_000 }),
        (millis) => {
          const text = new Date(millis).toISOString();

          assert.strictEqual(roundTrip(DATE_TIME, text), text);
          assert.strictEqual(getOrThrow(decodeIn(DATE_TIME, text)), millis);
        }
      )
    );
  });

  it("applies any offset exactly", () => {
    checkProperty(
      property(
        integer({ max: 253_402_200_000_000, min: -62_135_500_000_000 }),
        integer({ max: 23 * 60 + 59, min: -(23 * 60 + 59) }),
        (millis, offsetMinutes) => {
          const local = new Date(millis + offsetMinutes * 60_000)
            .toISOString()
            .slice(0, -1);

          const magnitude = Math.abs(offsetMinutes);
          const offset = `${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;

          assert.strictEqual(
            getOrThrow(decodeIn(DATE_TIME, `${local}${offset}`)),
            millis
          );
        }
      )
    );
  });
});

describe("date", () => {
  it("round-trips 0001-01-01, 9999-12-31 and 2024-02-29 whatever the process TZ", () => {
    for (const zone of TIME_ZONES) {
      withTimeZone(zone, () => {
        for (const text of [
          "0001-01-01",
          "9999-12-31",
          "2024-02-29",
          "2000-02-29",
          "1900-02-28",
        ]) {
          assert.strictEqual(roundTrip(DATE, text), text);
        }

        assert.strictEqual(reason(decodeIn(DATE, "1900-02-29")), "invalidDate");
        assert.strictEqual(reason(decodeIn(DATE, "0000-12-31")), "outOfRange");
        assert.strictEqual(
          reason(decodeIn(DATE, "2024-2-29")),
          "invalidFormat"
        );
        assert.strictEqual(
          reason(decodeIn(DATE, "2024-02-29T00:00:00Z")),
          "invalidFormat"
        );
      });
    }
  });

  it("round-trips every date and matches Date", () => {
    checkProperty(
      property(integer({ max: 2_932_896, min: -719_162 }), (days) => {
        const text = new Date(days * 86_400_000).toISOString().slice(0, 10);

        assert.strictEqual(roundTrip(DATE, text), text);
      })
    );
  });
});

describe("boolean", () => {
  it("omitted on create stores false; explicit null is InvalidValue", () => {
    const created = getOrThrow(planCreate(BOOLEAN, { present: false }));

    assert.deepStrictEqual(created, {
      action: "set",
      source: "empty",
      value: false,
    });
    assert.strictEqual(
      reason(planCreate(BOOLEAN, { json: null, present: true })),
      "nullNotAllowed"
    );
    assert.strictEqual(
      reason(planUpdate(BOOLEAN, { json: null, present: true })),
      "nullNotAllowed"
    );
    assert.strictEqual(roundTrip(BOOLEAN, true), true);
    assert.strictEqual(reason(decodeIn(BOOLEAN, "true")), "wrongJsonType");
  });
});

describe("absent versus null", () => {
  it("follows the 6.7 table", () => {
    assert.deepStrictEqual(
      getOrThrow(planCreate(TEXT, { present: false }, "default")),
      {
        action: "set",
        source: "default",
        value: "default",
      }
    );
    assert.deepStrictEqual(
      getOrThrow(planCreate(TEXT, { json: null, present: true }, "default")),
      {
        action: "set",
        source: "payload",
        value: null,
      }
    );
    assert.deepStrictEqual(getOrThrow(planCreate(TEXT, { present: false })), {
      action: "set",
      source: "empty",
      value: null,
    });
    assert.deepStrictEqual(getOrThrow(planUpdate(TEXT, { present: false })), {
      action: "keep",
    });
    assert.deepStrictEqual(
      getOrThrow(planUpdate(TEXT, { json: null, present: true })),
      {
        action: "set",
        source: "payload",
        value: null,
      }
    );
  });
});

describe("json", () => {
  it("refuses duplicate keys and inexact numbers; null is SQL NULL", () => {
    assert.strictEqual(
      reason(parseJson('{"a": 1, "b": {"c": 1, "c": 2}}')),
      "duplicateKey"
    );
    assert.strictEqual(
      reason(parseJson("0.1000000000000000055511151231257827")),
      "inexactNumber"
    );
    assert.strictEqual(reason(parseJson("9007199254740993")), "unsafeInteger");
    assert.strictEqual(getOrThrow(decodeIn(JSON_TYPE, null)), null);
    assert.deepStrictEqual(
      roundTrip(
        JSON_TYPE,
        getOrThrow(parseJson('{"b": [1.5, null], "a": "x"}'))
      ),
      {
        a: "x",
        b: [1.5, null],
      }
    );
  });

  it("changed agrees with jsonb for reordered keys", () => {
    const before = getOrThrow(
      parseJson('{"a": 1, "b": {"x": [1, 2], "y": null}}')
    );

    const reordered = getOrThrow(
      parseJson('{"b": {"y": null, "x": [1, 2.0]}, "a": 1.0}')
    );

    const changed = getOrThrow(
      parseJson('{"b": {"y": null, "x": [2, 1]}, "a": 1}')
    );

    assert.isTrue(storedEquals("json", before, reordered));
    assert.isFalse(storedEquals("json", before, changed));
  });

  it("limits size to 1 MiB", () => {
    assert.strictEqual(
      reason(decodeIn(JSON_TYPE, "x".repeat(1_048_575))),
      "tooLarge"
    );
    assert.isTrue(decodeIn(JSON_TYPE, "x".repeat(1_048_574)).ok);
  });
});

describe("password", () => {
  it('reads return {"set": true} and the plaintext never shows', () => {
    const plaintext = "correct horse battery staple";
    const decoded = getOrThrow(decodeIn(PASSWORD, plaintext));

    assert.isTrue(isPlaintext(decoded));
    assert.deepStrictEqual(roundTrip(PASSWORD, plaintext), { set: true });
    assert.deepStrictEqual(encodeOut(PASSWORD, null), { set: false });
    assert.deepStrictEqual(encodeOut(PASSWORD, secretState(false)), {
      set: false,
    });

    const shown = [
      JSON.stringify({ decoded }),
      String(decoded),
      inspect(decoded),
    ];

    for (const text of shown) {
      assert.notInclude(text, plaintext);
    }

    assert.strictEqual(isPlaintext(decoded) ? decoded.reveal() : "", plaintext);
    assert.strictEqual(reason(decodeIn(PASSWORD, "")), "emptyNotAllowed");

    const refused = decodeIn(PASSWORD, `${plaintext}\0`);
    assert.notInclude(
      refused.ok ? "" : JSON.stringify(refused.error),
      plaintext
    );
  });

  it("a new plaintext always counts as a change", () => {
    const decoded = getOrThrow(decodeIn(PASSWORD, "secret"));

    assert.isFalse(storedEquals("password", secretState(true), decoded));
    assert.isTrue(
      storedEquals("password", secretState(true), secretState(true))
    );
  });
});

describe("choice, reference and uuid", () => {
  const choices = {
    active: new Set(["open", "closed"]),
    retired: new Set(["legacy"]),
  };

  it("checks key format and the choice list", () => {
    assert.strictEqual(
      getOrThrow(decodeChoiceWrite("open", choices, null)),
      "open"
    );
    assert.strictEqual(
      getOrThrow(decodeChoiceWrite("legacy", choices, "legacy")),
      "legacy"
    );
    assert.strictEqual(
      reason(decodeChoiceWrite("legacy", choices, "open")),
      "retiredChoice"
    );
    assert.strictEqual(
      reason(decodeChoiceWrite("nope", choices, null)),
      "unknownChoice"
    );
    assert.strictEqual(
      reason(decodeChoiceWrite("Open", choices, null)),
      "invalidChoiceKey"
    );
    assert.strictEqual(
      reason(decodeChoiceWrite("_x", choices, null)),
      "invalidChoiceKey"
    );
    assert.strictEqual(
      reason(decodeChoiceWrite("a".repeat(64), choices, null)),
      "invalidChoiceKey"
    );
    assert.strictEqual(
      getOrThrow(
        decodeChoiceWrite(
          "9_a",
          { active: new Set(["9_a"]), retired: new Set() },
          null
        )
      ),
      "9_a"
    );
  });

  it("lowercases UUIDs accepted in any case", () => {
    const reference: FieldType = {
      kind: "reference",
      targetClassId: "01920c4e-0000-7000-8000-000000000001",
    };

    assert.strictEqual(
      roundTrip(reference, "01920C4E-7A3B-7C1D-9A2E-3F4B5C6D7E8F"),
      "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f"
    );
    assert.strictEqual(
      reason(decodeIn({ kind: "uuid" }, "01920c4e7a3b7c1d9a2e3f4b5c6d7e8f")),
      "invalidUuid"
    );
  });
});
