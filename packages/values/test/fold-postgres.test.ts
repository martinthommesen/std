import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { array, constantFrom, sample, string } from "fast-check";

import {
  fold,
  foldCodePoint,
  isAssignedInFoldTableVersion,
  textKey,
  UNICODE_VERSION,
} from "../src/fold.ts";
import { PostgresTest } from "./support/postgres.ts";

const MAX_CODE_POINT = 0x10_ff_ff;
const SURROGATE_FIRST = 0xd8_00;
const SURROGATE_LAST = 0xdf_ff;
const STRING_SAMPLES = 5000;

const scalarValues = function* scalarValues(): Generator<number> {
  for (let codePoint = 1; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    if (codePoint < SURROGATE_FIRST || codePoint > SURROGATE_LAST) {
      yield codePoint;
    }
  }
};

// Strings mixing edge characters, so multi-character folds meet context.
const EDGE_PIECES = [
  "ß",
  "ẞ",
  "ss",
  "SS",
  "İ",
  "i",
  "ı",
  "I",
  "Σ",
  "σ",
  "ς",
  "ﬁ",
  "ﬀ",
  "ŉ",
  "ΐ",
  "ᾈ",
  "ǅ",
  "\u0301",
  "\u0307",
  "e\u0301",
  "é",
  " ",
  "\t",
  "a",
  "Z",
  "%",
  "_",
  "\\",
  "😀",
  "👩\u200D👩\u200D👧",
  "𐐀",
  "𞤀",
  "Ⓐ",
  "Ａ",
];

const edgeStrings = array(constantFrom(...EDGE_PIECES), {
  maxLength: 12,
}).map((pieces) => pieces.join(""));

const anyStrings = string({ maxLength: 24, unit: "binary" }).map((text) =>
  text.replaceAll("\0", "")
);

interface FoldRow {
  readonly cp: number;
  readonly folded: string;
}

interface StringRow {
  readonly ord: string;
  readonly folded: string;
}

interface RangeRow {
  readonly first: number;
  readonly last: number;
}

layer(PostgresTest)("fold-postgres", (pg) => {
  pg.effect("the fold table's Unicode version equals Postgres's", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const [row] = yield* sql<{ readonly version: string }>`
        SELECT unicode_version() AS version
      `;

      assert.strictEqual(`${row?.version}.0`, UNICODE_VERSION);
    })
  );

  pg.effect(
    "fold equals casefold for every scalar value except U+0000 and surrogates",
    () =>
      Effect.gen(function* body() {
        const sql = yield* SqlClient.SqlClient;

        const rows = yield* sql<FoldRow>`
        SELECT cp, casefold(chr(cp) COLLATE pg_unicode_fast) AS folded
        FROM generate_series(1, ${MAX_CODE_POINT}) AS cp
        WHERE cp NOT BETWEEN ${SURROGATE_FIRST} AND ${SURROGATE_LAST}
          AND casefold(chr(cp) COLLATE pg_unicode_fast) <> chr(cp)
        ORDER BY cp
      `;

        const postgres = new Map(rows.map((row) => [row.cp, row.folded]));
        const typescript = new Map<number, string>();

        for (const codePoint of scalarValues()) {
          const folded = foldCodePoint(codePoint);

          if (folded !== String.fromCodePoint(codePoint)) {
            typescript.set(codePoint, folded);
          }
        }

        assert.isAbove(postgres.size, 1000);
        assert.deepStrictEqual(typescript, postgres);
      })
  );

  pg.effect("assigned code points equal unicode_assigned", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<RangeRow>`
        SELECT min(cp) AS first, max(cp) AS last
        FROM (
          SELECT cp, cp - row_number() OVER (ORDER BY cp) AS island
          FROM generate_series(1, ${MAX_CODE_POINT}) AS cp
          WHERE cp NOT BETWEEN ${SURROGATE_FIRST} AND ${SURROGATE_LAST}
            AND unicode_assigned(chr(cp))
        ) AS assigned
        GROUP BY island
        ORDER BY first
      `;

      const ranges: RangeRow[] = [];

      for (const codePoint of scalarValues()) {
        if (isAssignedInFoldTableVersion(codePoint)) {
          const last = ranges.at(-1);

          if (last?.last === codePoint - 1) {
            ranges[ranges.length - 1] = { first: last.first, last: codePoint };
          } else {
            ranges.push({ first: codePoint, last: codePoint });
          }
        }
      }

      // Surrogates split the ranges in both lists the same way.
      assert.deepStrictEqual(
        ranges,
        rows.map((row) => ({ first: row.first, last: row.last }))
      );
    })
  );

  pg.effect("[spike] per-code-point equality implies string equality", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const strings = [
        "ΣΑΣ",
        "ΣΑΣ ΣΑΣ.",
        "Straße",
        "STRASSE",
        "İ",
        "İstanbul",
        "ﬁﬀ",
        "ǅungla",
        "ᾈ",
        ...sample(edgeStrings, { numRuns: STRING_SAMPLES, seed: 5005 }),
        ...sample(anyStrings, { numRuns: STRING_SAMPLES, seed: 1601 }),
      ];

      const rows = yield* sql<StringRow>`
        SELECT ord::text AS ord, casefold(s COLLATE pg_unicode_fast) AS folded
        FROM unnest(${strings}::text[]) WITH ORDINALITY AS t(s, ord)
        ORDER BY t.ord
      `;

      assert.strictEqual(rows.length, strings.length);
      assert.deepStrictEqual(
        rows.map((row) => row.folded),
        strings.map((text) => fold(text))
      );
      assert.strictEqual(fold("ΣΑΣ"), "σασ");
      assert.strictEqual(fold("Straße"), "strasse");
      assert.strictEqual(fold("İ"), "i\u0307");
    })
  );

  pg.effect(
    'name = "STRASSE" matches stored "Straße"; "i" does not match "İ"',
    () =>
      Effect.gen(function* body() {
        const sql = yield* SqlClient.SqlClient;

        const [row] = yield* sql<{
          readonly strasse: boolean;
          readonly dotted: boolean;
        }>`
        SELECT
          casefold('Straße' COLLATE pg_unicode_fast) = ${textKey("STRASSE", false)} AS strasse,
          casefold('İ' COLLATE pg_unicode_fast) = ${textKey("i", false)} AS dotted
      `;

        assert.isTrue(row?.strasse);
        assert.isFalse(row?.dotted);
        assert.strictEqual(textKey("Straße", false), textKey("STRASSE", false));
        assert.notStrictEqual(textKey("İ", false), textKey("i", false));
        assert.notStrictEqual(
          textKey("Straße", true),
          textKey("STRASSE", true)
        );
      })
  );
});

describe("fold table", () => {
  it("is generated from Unicode 16.0.0", () => {
    assert.strictEqual(UNICODE_VERSION, "16.0.0");
    assert.strictEqual(foldCodePoint(0x1e_9e), "ss");
  });
});
