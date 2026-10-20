import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import {
  array,
  boolean,
  constant,
  constantFrom,
  dictionary,
  double,
  integer,
  letrec,
  oneof,
  sample,
  string,
} from "fast-check";

import { getOrThrow } from "../src/field-error.ts";
import { isJsonArray, isJsonObject } from "../src/json-value.ts";
import type { JsonValue } from "../src/json-value.ts";
import { JSON_MAX_DEPTH, parseJson, stringifyJson } from "../src/json.ts";
import { jsonbEquals, jsonbKeys } from "../src/jsonb.ts";
import { PostgresTest } from "./support/postgres.ts";

const KEYS = [
  "",
  "a",
  "b",
  "B",
  "aa",
  "ab",
  "é",
  "ü",
  "z",
  "1",
  "2",
  "10",
  "100",
  "-1",
  "01",
  "€",
  "😀",
  "\uFFFF",
  "key",
  "Key",
  "__proto__",
  "constructor",
  "a b",
  "\n",
  '"',
  "\\",
];

const MIN_PLAIN_NUMBER = -1e6;
const MAX_PLAIN_NUMBER = 1e6;
const SAMPLES = 1500;

// Numbers JavaScript prints without an exponent, so the text forms agree.
const plainNumber = oneof(
  integer({ max: Number.MAX_SAFE_INTEGER, min: -Number.MAX_SAFE_INTEGER }),
  double({
    max: MAX_PLAIN_NUMBER,
    min: MIN_PLAIN_NUMBER,
    noDefaultInfinity: true,
    noNaN: true,
  }).filter((value) => value === 0 || Math.abs(value) >= 1e-6)
);

const { json } = letrec<{ json: JsonValue }>((tie) => ({
  json: oneof(
    { depthSize: "small", withCrossShrink: true },
    constant(null),
    boolean(),
    plainNumber,
    string({ maxLength: 6, unit: "binary" }).map((text) =>
      text.replaceAll("\0", "")
    ),
    array(tie("json"), { maxLength: 4 }),
    dictionary(constantFrom(...KEYS), tie("json"), { maxKeys: 6 })
  ),
}));

// Writes a value the way jsonb_out does: {"k": v, ...} and [a, b].
const postgresStyle = (value: JsonValue): string => {
  if (isJsonArray(value)) {
    return `[${value.map((item) => postgresStyle(item)).join(", ")}]`;
  }

  if (isJsonObject(value)) {
    const members = jsonbKeys(value).map(
      (key) => `${JSON.stringify(key)}: ${postgresStyle(value[key] ?? null)}`
    );

    return `{${members.join(", ")}}`;
  }

  return JSON.stringify(value);
};

// Shuffles object keys (insertion order) and sometimes changes a leaf.
const variant = (value: JsonValue, random: () => number): JsonValue => {
  if (isJsonArray(value)) {
    return value.map((item) => variant(item, random));
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value).toSorted(() => random() - 0.5);
    const result: Record<string, JsonValue> = {};

    for (const key of keys) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: variant(value[key] ?? null, random),
        writable: true,
      });
    }

    return result;
  }

  return random() < 0.1 ? "changed" : value;
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed;

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state / 2_147_483_648;
  };
};

layer(PostgresTest)("jsonb-postgres", (pg) => {
  pg.effect("canonical key order equals jsonb's for generated values", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;
      const values = sample(json, { numRuns: SAMPLES, seed: 6005 });

      const rows = yield* sql<{ readonly text: string }>`
        SELECT j::jsonb::text AS text
        FROM unnest(${values.map((value) => stringifyJson(value))}::text[]) WITH ORDINALITY AS t(j, ord)
        ORDER BY t.ord
      `;

      assert.deepStrictEqual(
        rows.map((row) => row.text),
        values.map((value) => postgresStyle(value))
      );

      for (const value of values) {
        assert.isTrue(
          jsonbEquals(getOrThrow(parseJson(stringifyJson(value))), value)
        );
      }
    })
  );

  pg.effect("jsonb equality agrees for reordered and changed values", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;
      const random = seededRandom(42);
      const left = sample(json, { numRuns: SAMPLES, seed: 7007 });
      const right = left.map((value) => variant(value, random));

      const fixed: [string, string][] = [
        ['{"a":1.0}', '{"a":1}'],
        ["[1,2]", "[2,1]"],
        ["1", "[1]"],
        ['"1"', "1"],
        ['{"a":{"b":[]}}', '{"a":{"b":{}}}'],
        ["-0", "0"],
        ["1e2", "100"],
        ['{"b":1,"a":2}', '{"a":2,"b":1}'],
        ['{"a":null}', "{}"],
      ];

      const leftTexts = [
        ...left.map((value) => JSON.stringify(value)),
        ...fixed.map(([a]) => a),
      ];

      const rightTexts = [
        ...right.map((value) => JSON.stringify(value)),
        ...fixed.map(([, b]) => b),
      ];

      const rows = yield* sql<{ readonly equal: boolean }>`
        SELECT a::jsonb = b::jsonb AS equal
        FROM unnest(${leftTexts}::text[], ${rightTexts}::text[]) WITH ORDINALITY AS t(a, b, ord)
        ORDER BY t.ord
      `;

      const typescript = leftTexts.map((text, index) =>
        jsonbEquals(
          getOrThrow(parseJson(text)),
          getOrThrow(parseJson(rightTexts[index] ?? ""))
        )
      );

      assert.deepStrictEqual(
        rows.map((row) => row.equal),
        typescript
      );
      assert.isTrue(typescript.includes(true));
      assert.isTrue(typescript.includes(false));
    })
  );

  pg.effect(
    "digits a double cannot hold are refused; jsonb would keep them",
    () =>
      Effect.gen(function* body() {
        const sql = yield* SqlClient.SqlClient;
        const literal = "0.1000000000000000055511151231257827";

        const [row] = yield* sql<{
          readonly same: boolean;
          readonly text: string;
        }>`
        SELECT ${literal}::jsonb = '0.1'::jsonb AS same, ${literal}::jsonb::text AS text
      `;

        assert.isFalse(row?.same);
        assert.strictEqual(row?.text, literal);
        assert.strictEqual(JSON.parse(literal), 0.1);

        const parsed = parseJson(literal);
        assert.isFalse(parsed.ok);
        assert.strictEqual(
          parsed.ok ? "" : parsed.error.reason,
          "inexactNumber"
        );
      })
  );

  pg.effect("duplicate keys: jsonb keeps the last, STD refuses", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const [row] = yield* sql<{ readonly text: string }>`
        SELECT '{"a": 1, "a": 2}'::jsonb::text AS text
      `;

      assert.strictEqual(row?.text, '{"a": 2}');

      const parsed = parseJson('{"a": 1, "a": 2}');
      assert.strictEqual(parsed.ok ? "" : parsed.error.reason, "duplicateKey");
    })
  );

  pg.effect(
    "jsonb refuses U+0000 and accepts the deepest nesting STD accepts",
    () =>
      Effect.gen(function* body() {
        const sql = yield* SqlClient.SqlClient;

        const nul = yield* Effect.exit(
          sql`SELECT ${'"\\u0000"'}::jsonb AS value`
        );

        const deep = `${"[".repeat(JSON_MAX_DEPTH)}${"]".repeat(JSON_MAX_DEPTH)}`;

        const [row] = yield* sql<{ readonly depth: string }>`
        SELECT jsonb_typeof(${deep}::jsonb) AS depth
      `;

        assert.isTrue(Exit.isFailure(nul));
        assert.isTrue(parseJson(deep).ok);
        assert.isFalse(parseJson(`[${deep}]`).ok);
        assert.strictEqual(row?.depth, "array");
      })
  );
});

describe("jsonb text form", () => {
  it("separates members the way jsonb_out does", () => {
    assert.strictEqual(
      postgresStyle({ a: "x", b: [1, null] }),
      '{"a": "x", "b": [1, null]}'
    );
  });
});
