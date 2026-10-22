/**
 * `tmf-filter-equivalence` (Contracts 10.3, 10 acceptance tests): for
 * generated, valid TMF attribute filters over every condition-capable type
 * (text, decimal, integer, date, date-time, reference, one-hop path, uuid,
 * the class, boolean, big integer and, on the helpdesk, choice), the IDs
 * and their order from `/api/v2` equal those of the same query written in
 * the `condition` syntax, and of `/api/v1` with the text filter.
 *
 * Every sample must answer 200 on all three surfaces, and the successes
 * are counted against the runs. Text values are the exact stored values,
 * so the TMF filters' case-sensitive equality and the field's
 * case-insensitive one agree (D4); a separate test shows they differ for a
 * case-changed value. The callers are Alice (who reads everything) and Bob
 * (masks and hidden fields apply, so his queries leave `cost` out).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  assert as check,
  asyncProperty,
  constantFrom,
  oneof,
  subarray,
  tuple,
  uniqueArray,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { listPath, readsTestLayer } from "./reads-support.ts";
import { ACME, addField, change } from "./schema-support.ts";
import {
  asArray,
  asObject,
  idsOf,
  numberOf,
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
  readonly apiCondition: string | null;
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

const DATE_ONLY_LENGTH = "2026-01-01".length;

/**
 * A date-time literal for the condition syntax: a date-only TMF value
 * compares as the first instant of its UTC day (10.3).
 *
 * @param value - A date or an RFC 3339 date-time.
 * @returns The quoted literal.
 */
const firstInstant = (value: string): string =>
  JSON.stringify(
    value.length === DATE_ONLY_LENGTH ? `${value}T00:00:00.000Z` : value
  );

const COMPARISONS = constantFrom<Comparison>("gt", "gte", "lt", "lte");

const plain = (value: string): string => value;

/** A collection and its v1 table. */
interface Target {
  readonly collection: string;
  readonly table: string;
}

const ASSETS: Target = { collection: V2.asset, table: "acme.asset" };
const MONITORS: Target = { collection: V2.monitor, table: "acme.monitor" };

/** A query: a collection, some filters and a sort. */
interface Query {
  readonly target: Target;
  readonly filters: readonly Filter[];
  /** The sort in API names, and in definition names. */
  readonly sort: readonly [string, string];
  readonly caller: string;
}

/** What the generators draw their values from: the stored ones. */
interface Values {
  readonly users: readonly string[];
  readonly ids: readonly string[];
  readonly dateTimes: readonly string[];
  readonly dayOnly: readonly string[];
}

const NAMES = ["S", "K", "L", "M", "Alice monitor"];
const MONITOR_NAMES = ["M", "Alice monitor"];
const STATUSES = ["lost", "in_use"];
const COSTS = ["0", "300", "400", "1200", "1800", "2500", "999.99"];
const SIZES = ["0", "24", "25", "27", "100"];
const BIG_COUNTS = ["0", "5", "9007199254740993", "9223372036854775807"];

const TYPES: readonly (readonly [string, string])[] = [
  ["AcmeAsset", "acme.asset"],
  ["AcmeLaptop", "acme.laptop"],
  ["AcmeMonitor", "acme.monitor"],
];

const DATES = [
  "2023-03-10",
  "2024-06-01",
  "2025-01-15",
  "2025-02-01",
  "2025-03-01",
];

const classFilter = (types: readonly (readonly [string, string])[]): Filter => {
  const definition = types.map(([, name]) => quoted(name));

  return {
    apiCondition: null,
    definitionCondition:
      definition.length === 1
        ? `class = ${definition.join("")}`
        : `class in (${definition.join(", ")})`,
    parameter: ["@type", types.map(([name]) => name).join(",")],
  };
};

const subset = <T>(values: readonly T[], maxLength = 2): Arbitrary<T[]> =>
  subarray([...values], { maxLength, minLength: 1 });

const costFilters = (hasCost: boolean): Arbitrary<Filter>[] =>
  hasCost
    ? [
        tuple(COMPARISONS, constantFrom(...COSTS)).map(([operator, value]) =>
          comparison("cost", "cost", operator, value, plain)
        ),
      ]
    : [];

/**
 * Filters over the asset collection, one per condition-capable type. Bob
 * never reads `cost`, so his filters leave it out.
 *
 * @param values - The stored values.
 * @param hasCost - Whether the caller may name `cost`.
 * @returns The arbitrary.
 */
const assetFilter = (values: Values, hasCost: boolean): Arbitrary<Filter> =>
  oneof(
    subset(NAMES, 3).map((names) => equality("name", "name", names, quoted)),
    subset(STATUSES).map((names) =>
      equality("status", "status", names, quoted)
    ),
    tuple(COMPARISONS, constantFrom(...DATES)).map(([operator, value]) =>
      comparison("purchasedOn", "purchased_on", operator, value, quoted)
    ),
    tuple(
      COMPARISONS,
      constantFrom(...values.dateTimes, ...values.dayOnly)
    ).map(([operator, value]) =>
      comparison("creationDate", "created_at", operator, value, firstInstant)
    ),
    subset(values.users).map((ids) => equality("owner", "owner", ids, quoted)),
    subset(values.users).map((ids) =>
      equality("owner.id", "owner.id", ids, quoted)
    ),
    subset(["Alice monitor", "L"]).map((names) =>
      equality("dockedTo.name", "docked_to.name", names, quoted)
    ),
    subset(values.ids, 3).map((ids) => equality("id", "id", ids, quoted)),
    subset(TYPES).map(classFilter),
    constantFrom("true", "false").map((flag) =>
      equality("flag", "flag", [flag], plain)
    ),
    tuple(COMPARISONS, constantFrom(...BIG_COUNTS)).map(([operator, value]) =>
      comparison("bigCount", "big_count", operator, value, plain)
    ),
    ...costFilters(hasCost)
  );

const sizeFilters: Arbitrary<Filter>[] = [
  subset(SIZES, 3).map((sizes) =>
    equality("sizeInches", "size_inches", sizes, plain)
  ),
  tuple(COMPARISONS, constantFrom(...SIZES)).map(([operator, value]) =>
    comparison("sizeInches", "size_inches", operator, value, plain)
  ),
];

/**
 * Filters over the monitor collection, which holds the integer.
 *
 * @param hasCost - Whether the caller may name `cost`.
 * @returns The arbitrary.
 */
const monitorFilter = (hasCost: boolean): Arbitrary<Filter> =>
  oneof(
    subset(MONITOR_NAMES).map((names) =>
      equality("name", "name", names, quoted)
    ),
    // Bob reads no monitor field beyond the asset's, so no size for him.
    ...(hasCost ? sizeFilters : []),
    ...costFilters(hasCost)
  );

const ALICE_ASSET_SORTS = [
  ["name", "name"],
  ["-cost", "-cost"],
  ["purchasedOn", "purchased_on"],
  ["-status,name", "-status,name"],
  ["creationDate,name", "created_at,name"],
] as const;

const BOB_ASSET_SORTS = [
  ["name", "name"],
  ["purchasedOn", "purchased_on"],
  ["-status,name", "-status,name"],
] as const;

const BOB_MONITOR_SORTS = [["name", "name"]] as const;

const MONITOR_SORTS = [
  ["name", "name"],
  ["-sizeInches,name", "-size_inches,name"],
] as const;

const distinctFilters = (filters: Arbitrary<Filter>): Arbitrary<Filter[]> =>
  // One filter per parameter: repeats of a parameter are OR (10.3).
  uniqueArray(filters, {
    maxLength: 3,
    minLength: 1,
    selector: (filter) => filter.parameter[0],
  });

const queryOf = (values: Values): Arbitrary<Query> =>
  oneof(
    ...(["alice", "bob"] as const).flatMap((caller) => {
      const hasCost = caller === "alice";

      const assets = tuple(
        distinctFilters(assetFilter(values, hasCost)),
        constantFrom(...(hasCost ? ALICE_ASSET_SORTS : BOB_ASSET_SORTS))
      ).map(([filters, sort]): Query => ({
        caller,
        filters,
        sort,
        target: ASSETS,
      }));

      const monitors = tuple(
        distinctFilters(monitorFilter(hasCost)),
        constantFrom(...(hasCost ? MONITOR_SORTS : BOB_MONITOR_SORTS))
      ).map(([filters, sort]): Query => ({
        caller,
        filters,
        sort,
        target: MONITORS,
      }));

      return [assets, monitors];
    })
  );

const recordIds = (response: TestResponse): string[] =>
  asArray(asObject(response.json).records).map((item) =>
    textOf(asObject(item).id)
  );

const and = (conditions: readonly string[]): string =>
  conditions.map((condition) => `(${condition})`).join(" and ");

/**
 * The `condition` parameter for the filters it can express, and the TMF
 * parameter for the class, which the syntax cannot name.
 *
 * @param filters - The filters.
 * @returns The query parameters.
 */
const conditionParameters = (
  filters: readonly Filter[]
): (readonly [string, string])[] => {
  const conditions = filters.flatMap((filter) =>
    filter.apiCondition === null ? [] : [filter.apiCondition]
  );

  const classes = filters.flatMap((filter) =>
    filter.apiCondition === null ? [filter.parameter] : []
  );

  return conditions.length === 0
    ? classes
    : [["condition", and(conditions)], ...classes];
};

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
  const [apiSort, definitionSort] = query.sort;

  const tmf = yield* http.get(
    withQuery(query.target.collection, [
      ...query.filters.map((filter) => filter.parameter),
      ["sort", apiSort],
    ]),
    { token }
  );

  const condition = yield* http.get(
    withQuery(query.target.collection, [
      ...conditionParameters(query.filters),
      ["sort", apiSort],
    ]),
    { token }
  );

  const v1 = yield* http.get(
    listPath(query.target.table, {
      filter: and(query.filters.map((f) => f.definitionCondition)),
      sort: definitionSort,
    }),
    { token }
  );

  return { condition, tmf, v1 };
});

/** What a property run saw. */
interface Tally {
  /** Samples that answered 200 on all three surfaces and agreed. */
  successes: number;
  /** Of those, samples that found at least one record. */
  nonEmpty: number;
}

/**
 * Runs the generated queries; every sample must answer 200 on all three
 * surfaces, with the same IDs in the same order.
 *
 * @param queries - The generator.
 * @param tokens - Bearer tokens by caller.
 * @returns The tally.
 */
const runSamples = Effect.fn("TmfFilterEquivalence.runSamples")(
  function* runSamples(
    queries: Arbitrary<Query>,
    tokens: Readonly<Record<string, string>>
  ) {
    const services = yield* Effect.context<TestHttpClient>();
    const run = Effect.runPromiseWith(services);
    const tally: Tally = { nonEmpty: 0, successes: 0 };

    const sample = async (query: Query) => {
      const observed = await run(observe(query, tokens[query.caller] ?? ""));
      const label = JSON.stringify(query);

      for (const [surface, response] of Object.entries(observed)) {
        assert.strictEqual(
          response.status,
          200,
          `${surface} ${label}: ${response.text}`
        );
      }

      assert.deepStrictEqual(
        idsOf(observed.tmf),
        idsOf(observed.condition),
        label
      );
      assert.deepStrictEqual(
        idsOf(observed.tmf),
        recordIds(observed.v1),
        label
      );

      tally.successes += 1;

      if (idsOf(observed.tmf).length > 0) {
        tally.nonEmpty += 1;
      }
    };

    yield* Effect.promise(async () => {
      await check(asyncProperty(queries, sample), {
        numRuns: RUNS,
        seed: SEED,
      });
    });

    return tally;
  }
);

/**
 * Adds a boolean and a big integer to assets and stores values on every
 * fixture asset (as the administrator), so the generators cover both.
 */
const addMissingTypes = Effect.gen(function* addMissingTypes() {
  const http = yield* TestHttpClient;
  const { records } = yield* AcmeFixture;
  const admin = yield* http.signIn("ada", "ada-password");

  yield* change([
    addField(ACME.asset, "flag", { kind: "boolean" }).op,
    addField(ACME.asset, "big_count", { kind: "bigInteger" }).op,
  ]).pipe(Effect.orDie);

  const stored: readonly (readonly [string, boolean, string])[] = [
    [records.L, true, "9007199254740993"],
    [records.K, false, "5"],
    [records.M, true, "9223372036854775807"],
    [records.AM, false, "0"],
    [records.S, true, "5"],
  ];

  for (const [id, flag, bigCount] of stored) {
    const path = `${V2.asset}/${id}`;
    const current = asObject((yield* http.get(path, { token: admin })).json);

    const patched = yield* http.request("PATCH", path, {
      headers: {
        "content-type": "application/merge-patch+json",
        "if-match": `"${numberOf(current.revision)}"`,
      },
      rawBody: JSON.stringify({ bigCount, flag }),
      token: admin,
    });

    assert.strictEqual(patched.status, 200, patched.text);
  }
});

/**
 * The values the generators draw from: users, record IDs and the stored
 * creation dates (as date-times and as UTC days).
 */
const storedValues = Effect.gen(function* storedValues() {
  const http = yield* TestHttpClient;
  const { alice, bob, records } = yield* AcmeFixture;
  const token = yield* http.signIn("alice", "alice-password");
  const listed = yield* http.get(V2.asset, { token });

  const created = asArray(listed.json).map((item) =>
    textOf(asObject(item).creationDate)
  );

  return {
    dateTimes: created,
    dayOnly: created.map((value) => value.slice(0, "2026-01-01".length)),
    ids: Object.values(records),
    users: [alice.id, bob.id],
  } satisfies Values;
});

const lowerCased = (value: string): string => value.toLowerCase();

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

          yield* addMissingTypes;

          const values = yield* storedValues;

          const tokens = {
            alice: yield* http.signIn("alice", "alice-password"),
            bob: yield* http.signIn("bob", "bob-password"),
          };

          const tally = yield* runSamples(queryOf(values), tokens);

          assert.strictEqual(tally.successes, RUNS);
          assert.isAbove(tally.nonEmpty, 0);
        }),
      { timeout: 300_000 }
    );

    dbTest.effect(
      "a case-changed text value finds nothing through TMF filters, and the same records through condition",
      () =>
        Effect.gen(function* caseChanged() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("alice", "alice-password");

          for (const name of ["K", "L", "Alice monitor"]) {
            const exact = yield* http.get(
              withQuery(V2.asset, [["name", name]]),
              { token }
            );

            const changed = yield* http.get(
              withQuery(V2.asset, [["name", lowerCased(name)]]),
              { token }
            );

            const condition = yield* http.get(
              withQuery(V2.asset, [
                ["condition", `name = ${quoted(lowerCased(name))}`],
              ]),
              { token }
            );

            const v1 = yield* http.get(
              listPath("acme.asset", {
                filter: `name = ${quoted(lowerCased(name))}`,
              }),
              { token }
            );

            assert.strictEqual(exact.status, 200);
            assert.lengthOf(idsOf(exact), 1, name);
            assert.strictEqual(changed.status, 200);
            assert.deepStrictEqual(idsOf(changed), [], name);
            assert.deepStrictEqual(idsOf(condition), idsOf(exact), name);
            assert.deepStrictEqual(recordIds(v1), idsOf(exact), name);
          }
        })
    );
  });

  layer(TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer())), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "choice filters agree on the helpdesk, with the same rules",
      () =>
        Effect.gen(function* choices() {
          const http = yield* TestHttpClient;
          const { records } = yield* HelpdeskFixture;

          const tokens = {
            admin: yield* http.signIn("admin", "helpdesk-admin-demo-password"),
            agent: yield* http.signIn("agent", "helpdesk-agent-demo-password"),
          };

          const filters = oneof(
            subset(["new", "in_progress", "on_hold", "resolved"], 3).map(
              (keys) => equality("status", "status", keys, quoted)
            ),
            subset(["critical", "high", "moderate", "low"], 3).map((keys) =>
              equality("priority", "priority", keys, quoted)
            ),
            subset(Object.values(records), 3).map((ids) =>
              equality("id", "id", ids, quoted)
            ),
            subset([
              ["HelpdeskTicket", "helpdesk.ticket"],
              ["HelpdeskIncident", "helpdesk.incident"],
            ] as const).map(classFilter)
          );

          const ticket: Target = {
            collection: "/api/v2/helpdeskTicket",
            table: "helpdesk.ticket",
          };

          const queries = tuple(
            constantFrom("admin", "agent"),
            distinctFilters(filters),
            constantFrom(
              ...([
                ["shortDescription", "short_description"],
                ["-priority,shortDescription", "-priority,short_description"],
              ] as const)
            )
          ).map(([caller, drawn, sort]): Query => ({
            caller,
            filters: drawn,
            sort,
            target: ticket,
          }));

          const tally = yield* runSamples(queries, tokens);

          assert.strictEqual(tally.successes, RUNS);
          assert.isAbove(tally.nonEmpty, 0);
        }),
      { timeout: 300_000 }
    );
  });
});
