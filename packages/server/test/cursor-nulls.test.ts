/**
 * `cursor-nulls` (Contracts 3.5): 1,000 visible rows with half the sort
 * keys hidden from the caller, paged 7 at a time ascending and descending,
 * return every visible row exactly once, in the order of one unpaged query.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { ACME, AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import type { OwnerRecord } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { keyExpression } from "../src/records/read-cursor.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { allPages, listOf, listPath, readsTestLayer } from "./reads-support.ts";

const ROWS = 1000;
const PAGE = "7";
const MULTIPLIER = 1_103_515_245;
const INCREMENT = 12_345;
const MODULUS = 2 ** 31;
const DAYS = 28;
const NULL_SHARE = 0.1;
const MAX_COST = 3000;
const LOST_SHARE = 0.5;

/**
 * A deterministic sequence of pseudo-random numbers.
 * @param seed - The start.
 * @returns The next number from 0 to 1.
 */
const sequence = (seed: number) => {
  let state = seed;

  return (): number => {
    state = (state * MULTIPLIER + INCREMENT) % MODULUS;

    return state / MODULUS;
  };
};

/**
 * Bob's bulk assets: half lost (their purchased_on is hidden from him),
 * some without a date, many with equal dates.
 * @param bob - Bob's user ID.
 * @param random - The number source.
 * @returns The records.
 */
const bulkRecords = (bob: string, random: () => number): OwnerRecord[] =>
  Array.from({ length: ROWS }, (_, index) => ({
    by: bob,
    values: {
      cost: String(Math.floor(random() * MAX_COST)),
      name: `bulk-${String(index).padStart(4, "0")}`,
      owner: bob,
      purchased_on:
        random() < NULL_SHARE
          ? null
          : `2024-01-${String(1 + Math.floor(random() * DAYS)).padStart(2, "0")}`,
      status: random() < LOST_SHARE ? "lost" : "in_use",
    },
  }));

const SORTS = [
  "purchasedOn",
  "-purchasedOn",
  "status,-purchasedOn",
  "-status,purchasedOn,name",
];

describe("cursor-nulls", () => {
  it("sorts text in code point order through a collation, never a row comparison", () => {
    const key = keyExpression(
      { kind: "text" },
      { parameters: [], parts: ['"r"."name"'] }
    );

    assert.include(key.parts.join(""), "casefold");
    assert.include(key.parts.join(""), "pg_unicode_fast");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "keyset pages over masked keys return every row once, in order",
      () =>
        Effect.gen(function* cursorNulls() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const catalog = yield* Catalog;
          const { request } = yield* Transactions;
          const random = sequence(7);

          yield* request(
            Effect.gen(function* insertBulk() {
              const snapshot = yield* catalog.current;

              yield* insertAsOwner(
                snapshot,
                ACME.asset,
                bulkRecords(fixture.bob.id, random)
              );
            })
          );

          const token = yield* http.signIn("bob", "bob-password");
          const condition = 'name starts with "bulk-"';

          for (const sort of SORTS) {
            const unpaged = yield* listOf(
              yield* http.get(
                listPath("acme.asset", {
                  condition,
                  limit: String(ROWS),
                  sort,
                }),
                { token }
              )
            );

            const paged = yield* allPages({ token }, "acme.asset", {
              condition,
              limit: PAGE,
              sort,
            });

            const expected = unpaged.resources.map((resource) => resource.id);
            const actual = paged.resources.map((resource) => resource.id);

            assert.strictEqual(expected.length, ROWS, sort);
            assert.strictEqual(new Set(actual).size, actual.length, sort);
            assert.deepStrictEqual(actual, expected, sort);

            if (sort === "purchasedOn") {
              // Hidden and empty keys are absent and sort last, ascending.
              const hidden = unpaged.resources.map(
                (resource) => !("purchasedOn" in resource)
              );

              const firstHidden = hidden.indexOf(true);

              assert.isTrue(firstHidden > 0);
              assert.isTrue(hidden.slice(firstHidden).every(Boolean));
            }
          }
        }),
      { timeout: 120_000 }
    );
  });
});
