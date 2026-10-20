import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { boolean, constantFrom, record, sample, string } from "fast-check";

import {
  escapeLike,
  likePattern,
  matchesPattern,
} from "../src/like-pattern.ts";
import type { PatternOperator } from "../src/like-pattern.ts";
import { PostgresTest } from "./support/postgres.ts";

const ASCII_LAST = 0x7f;

const OPERATORS: readonly PatternOperator[] = [
  "contains",
  "startsWith",
  "endsWith",
];

const asciiCharacters = Array.from({ length: ASCII_LAST }, (_, index) =>
  String.fromCodePoint(index + 1)
);

interface Case {
  readonly haystack: string;
  readonly needle: string;
  readonly operator: PatternOperator;
  readonly caseSensitive: boolean;
}

const haystacksFor = (character: string): string[] => [
  character,
  `x${character}y`,
  `${character}${character}`,
  `${character}z`,
  `z${character}`,
  "xy",
  "a",
  "A",
  "%",
  "_",
  "\\",
  "\\\\",
  "a%b",
  "a_b",
];

const asciiCases = (): Case[] => {
  const cases: Case[] = [];

  for (const character of asciiCharacters) {
    for (const needle of [character, `a${character}`, `${character}b`]) {
      for (const haystack of haystacksFor(character)) {
        for (const operator of OPERATORS) {
          cases.push(
            { caseSensitive: false, haystack, needle, operator },
            { caseSensitive: true, haystack, needle, operator }
          );
        }
      }
    }
  }

  return cases;
};

const generatedCases = (): Case[] =>
  sample(
    record({
      caseSensitive: boolean(),
      haystack: string({ maxLength: 12, unit: "binary" }),
      needle: string({ maxLength: 4, unit: "binary" }),
      operator: constantFrom(...OPERATORS),
    }),
    { numRuns: 4000, seed: 2024 }
  ).map((generated) => ({
    ...generated,
    haystack: generated.haystack.replaceAll("\0", ""),
    needle: generated.needle.replaceAll("\0", ""),
  }));

layer(PostgresTest)("like-postgres", (pg) => {
  pg.effect("LIKE escaping holds for every ASCII character", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;
      const cases = [...asciiCases(), ...generatedCases()];

      const rows = yield* sql<{ readonly matched: boolean }>`
        SELECT CASE WHEN c.cs
            THEN c.h LIKE c.p
            ELSE casefold(c.h COLLATE pg_unicode_fast) LIKE c.p
          END AS matched
        FROM unnest(
          ${cases.map((item) => item.haystack)}::text[],
          ${cases.map((item) => likePattern(item.operator, item.needle, item.caseSensitive))}::text[],
          ${cases.map((item) => item.caseSensitive)}::boolean[]
        ) WITH ORDINALITY AS c(h, p, cs, ord)
        ORDER BY c.ord
      `;

      assert.strictEqual(rows.length, cases.length);

      const mismatches = cases.filter(
        (item, index) =>
          rows[index]?.matched !==
          matchesPattern(
            item.operator,
            item.haystack,
            item.needle,
            item.caseSensitive
          )
      );

      assert.deepStrictEqual(mismatches, []);
    })
  );

  pg.effect("an escaped character matches only itself", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const patterns = asciiCharacters.map((character) =>
        escapeLike(character)
      );

      const rows = yield* sql<{ readonly matches: string }>`
        SELECT string_agg(h, '' ORDER BY h COLLATE "C") AS matches
        FROM unnest(${patterns}::text[]) WITH ORDINALITY AS p(pattern, ord)
        CROSS JOIN LATERAL (
          SELECT h FROM unnest(${asciiCharacters}::text[]) AS hs(h) WHERE h LIKE p.pattern
        ) AS hit
        GROUP BY p.ord
        ORDER BY p.ord
      `;

      assert.deepStrictEqual(
        rows.map((row) => row.matches),
        asciiCharacters
      );
    })
  );
});

describe("LIKE escaping in TypeScript", () => {
  it("escapes exactly backslash, percent and underscore", () => {
    const escaped = asciiCharacters.filter(
      (character) => escapeLike(character) !== character
    );

    assert.deepStrictEqual(escaped, ["%", "\\", "_"]);
  });
});
