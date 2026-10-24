/**
 * `cursor-nulls` (Contracts 3.5): 1,000 visible rows with half the sort
 * keys hidden from the caller, paged 7 at a time ascending and descending,
 * return every visible row exactly once, in the order of one unpaged query.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { keyExpression } from "../src/records/read-cursor.ts";
import { DatabaseConfig } from "../src/sql/database-config.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  bulkRecords,
  CURSOR_ROWS as ROWS,
  CURSOR_SORTS as SORTS,
  sequence,
} from "./authz-support.ts";
import { allPages, listOf, listPath, readsTestLayer } from "./reads-support.ts";

const PAGE = "7";

const checkSortedTraversal = Effect.fn("cursor-nulls.checkSortedTraversal")(
  function* checkSortedTraversal(caller: TestRequestOptions, sort: string) {
    const http = yield* TestHttpClient;
    const condition = 'name starts with "bulk-"';

    const unpaged = yield* listOf(
      yield* http.get(
        listPath("acme.asset", {
          condition,
          limit: String(ROWS),
          sort,
        }),
        caller
      )
    );

    const paged = yield* allPages(caller, "acme.asset", {
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
);

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

          const config = yield* DatabaseConfig;

          // Reserve half the configured pool, as in child-endpoint-reads.sortAll.
          const concurrency = Math.max(
            1,
            Math.floor(config.maxConnections / 2)
          );

          yield* Effect.all(
            SORTS.map((sort) => checkSortedTraversal({ token }, sort)),
            { concurrency, discard: true }
          );
        }),
      { timeout: 120_000 }
    );
  });
});
