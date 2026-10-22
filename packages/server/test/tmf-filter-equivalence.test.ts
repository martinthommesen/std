/**
 * `tmf-filter-equivalence` (Contracts 10.3, 10 acceptance tests): for
 * generated TMF attribute filters over every condition-capable type of the
 * acme set (text, decimal, date, reference, integer, the class), the IDs
 * and their order from `/api/v2` equal those of the same query written in
 * the `condition` syntax, and of `/api/v1` with the text filter.
 *
 * Every TMF filter becomes a condition AST before anything runs, so the
 * three must agree whatever the values; the callers are Alice (who reads
 * everything) and Bob (masks and hidden fields apply).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import {
  assert as check,
  asyncProperty,
  constantFrom,
  oneof,
  record,
  subarray,
  tuple,
  uniqueArray,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { listPath, readsTestLayer } from "./reads-support.ts";
import {
  asArray,
  asObject,
  idsOf,
  textOf,
  V2,
  withQuery,
} from "./v2-support.ts";

const RUNS = 60;
const SEED = 20_261_022;

/** One attribute filter and its condition-syntax twin. */
interface Filter {
  /** The TMF parameter. */
  readonly parameter: readonly [string, string];
  /** The condition in API names (v2 `condition`). */
  readonly apiCondition: string;
  /** The condition in definition names (v1 `filter`). */
  readonly definitionCondition: string;
}

type Comparison = "gt" | "gte" | "lt" | "lte";

const SYMBOLS: Readonly<Record<Comparison, string>> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const quoted = (value: string): string => JSON.stringify(value);

/**
 * An equality filter: `=` for one value, `in` for several.
 *
 * @param api - The attribute's API name.
 * @param definition - The attribute's definition name.
 * @param values - The values.
 * @param literal - Renders a value as condition text.
 * @returns The filter.
 */
export const equality = (
  api: string,
  definition: string,
  values: readonly string[],
  literal: (value: string) => string
): Filter => {
  const condition = (name: string) =>
    values.length === 1
      ? `${name} = ${literal(values[0] ?? "")}`
      : `${name} in (${values.map(literal).join(", ")})`;

  return {
    apiCondition: condition(api),
    definitionCondition: condition(definition),
    parameter: [api, values.join(",")],
  };
};

const comparison = (
  api: string,
  definition: string,
  operator: Comparison,
  value: string,
  literal: (value: string) => string
): Filter => ({
  apiCondition: `${api} ${SYMBOLS[operator]} ${literal(value)}`,
  definitionCondition: `${definition} ${SYMBOLS[operator]} ${literal(value)}`,
  parameter: [`${api}.${operator}`, value],
});

const COMPARISONS = constantFrom<Comparison>("gt", "gte", "lt", "lte");

const NAMES = ["S", "K", "L", "M", "Alice monitor", "k", "none"];
const STATUSES = ["lost", "in_use", "spare"];
const COSTS = ["0", "300", "400", "1200", "1800", "2500", "999.99"];

const DATES = [
  "2023-03-10",
  "2024-06-01",
  "2025-01-15",
  "2025-02-01",
  "2025-03-01",
];

/**
 * Filters over the acme asset's fields, one per condition-capable type.
 *
 * @param users - Alice's and Bob's IDs.
 * @returns The arbitrary.
 */
const filterOf = (users: readonly string[]): Arbitrary<Filter> =>
  oneof(
    subarray(NAMES, { maxLength: 3, minLength: 1 }).map((values) =>
      equality("name", "name", values, quoted)
    ),
    subarray(STATUSES, { maxLength: 2, minLength: 1 }).map((values) =>
      equality("status", "status", values, quoted)
    ),
    tuple(COMPARISONS, constantFrom(...COSTS)).map(([operator, value]) =>
      comparison("cost", "cost", operator, value, (text) => text)
    ),
    tuple(COMPARISONS, constantFrom(...DATES)).map(([operator, value]) =>
      comparison("purchasedOn", "purchased_on", operator, value, quoted)
    ),
    subarray([...users], { maxLength: 2, minLength: 1 }).map((values) =>
      equality("owner", "owner", values, quoted)
    )
  );

/** A query: some filters and a sort. */
interface Query {
  readonly filters: readonly Filter[];
  readonly sort: string;
  readonly caller: "alice" | "bob";
}

const SORTS: readonly (readonly [string, string])[] = [
  ["name", "name"],
  ["-cost", "-cost"],
  ["purchasedOn", "purchased_on"],
  ["-status,name", "-status,name"],
];

const queryOf = (users: readonly string[]): Arbitrary<Query> =>
  record({
    caller: constantFrom<"alice" | "bob">("alice", "bob"),
    // One filter per parameter: repeats of a parameter are OR (10.3).
    filters: uniqueArray(filterOf(users), {
      maxLength: 3,
      minLength: 1,
      selector: (filter) => filter.parameter[0],
    }),
    sort: constantFrom(...SORTS.map(([api]) => api)),
  });

const definitionSort = (api: string): string =>
  SORTS.find(([candidate]) => candidate === api)?.[1] ?? api;

const recordIds = (response: TestResponse): string[] =>
  asArray(asObject(response.json).records).map((item) =>
    textOf(asObject(item).id)
  );

const and = (conditions: readonly string[]): string =>
  conditions.map((condition) => `(${condition})`).join(" and ");

/**
 * Runs one query as TMF parameters, as a condition and through v1.
 *
 * @param query - The query.
 * @param token - The caller's bearer token.
 * @returns The three responses.
 */
const observe = Effect.fn("TmfFilterEquivalence.observe")(function* observe(
  query: Query,
  token: string
) {
  const http = yield* TestHttpClient;

  const tmf = yield* http.get(
    withQuery(V2.asset, [
      ...query.filters.map((filter) => filter.parameter),
      ["sort", query.sort],
    ]),
    { token }
  );

  const condition = yield* http.get(
    withQuery(V2.asset, [
      ["condition", and(query.filters.map((f) => f.apiCondition))],
      ["sort", query.sort],
    ]),
    { token }
  );

  const v1 = yield* http.get(
    listPath("acme.asset", {
      filter: and(query.filters.map((f) => f.definitionCondition)),
      sort: definitionSort(query.sort),
    }),
    { token }
  );

  return { condition, tmf, v1 };
});

describe("tmf-filter-equivalence", () => {
  it("equality renders one value as = and several as in", () => {
    assert.strictEqual(
      equality("name", "name", ["S"], quoted).apiCondition,
      'name = "S"'
    );
    assert.strictEqual(
      equality("name", "name", ["S", "K"], quoted).apiCondition,
      'name in ("S", "K")'
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "TMF filters, the condition syntax and v1's filter return the same IDs in the same order",
      () =>
        Effect.gen(function* equivalence() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* AcmeFixture;

          const tokens = {
            alice: yield* http.signIn("alice", "alice-password"),
            bob: yield* http.signIn("bob", "bob-password"),
          };

          const services = yield* Effect.context<TestHttpClient>();
          const run = Effect.runPromiseWith(services);
          let compared = 0;

          const sample = async (query: Query) => {
            const token = tokens[query.caller];

            const observed = await run(observe(query, token));

            const v1Ids = recordIds(observed.v1);

            assert.strictEqual(
              observed.tmf.status,
              observed.v1.status,
              JSON.stringify(query)
            );
            assert.strictEqual(observed.condition.status, observed.v1.status);
            assert.deepStrictEqual(
              idsOf(observed.tmf),
              idsOf(observed.condition)
            );

            if (observed.v1.status === 200) {
              assert.deepStrictEqual(idsOf(observed.tmf), v1Ids);
            }

            compared += 1;
          };

          yield* Effect.promise(async () => {
            await check(asyncProperty(queryOf([alice.id, bob.id]), sample), {
              numRuns: RUNS,
              seed: SEED,
            });
          });

          assert.strictEqual(compared, RUNS);
        }),
      { timeout: 300_000 }
    );
  });
});
