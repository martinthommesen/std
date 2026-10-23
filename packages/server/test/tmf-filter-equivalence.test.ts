/**
 * `tmf-filter-equivalence` (Contracts 10.3, 10 acceptance tests): for
 * generated, valid TMF attribute filters over every condition-capable type
 * (text, decimal, integer, date, date-time, reference, one-hop path, uuid,
 * the class, boolean, big integer and, on the helpdesk, choice), the IDs
 * and their order equal those of the same query written in the
 * `condition` syntax.
 *
 * Every sample must answer 200 on both surfaces, and the successes
 * are counted against the runs. Text values are the exact stored values,
 * so the TMF filters' case-sensitive equality and the field's
 * case-insensitive one agree (D4); a separate test shows they differ for a
 * case-changed value. The callers are Alice (who reads everything) and Bob
 * (masks and hidden fields apply, so his queries leave `cost` out).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
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
import {
  asArray,
  asObject,
  idsOf,
  numberOf,
  textOf,
  API,
  withQuery,
} from "./api-support.ts";
import { createTicket, itilLayer } from "./itil-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  ACME,
  addField,
  change,
  values as sqlValues,
} from "./schema-support.ts";
import { itemsOf, TICKETS, tmf621As } from "./tmf621-support.ts";
import type { Tmf621Client } from "./tmf621-support.ts";

const RUNS = 60;
const SEED = 20_261_022;

/** One attribute filter and its condition-syntax twin. */
interface Filter {
  /** The TMF parameter. */
  readonly parameter: readonly [string, string];
  /** The condition in API names (v2 `condition`). */
  readonly apiCondition: string | null;
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
 * @param values - The values.
 * @param literal - Renders a value as condition text.
 * @returns The filter.
 */
export const equality = (
  api: string,
  values: readonly string[],
  literal: (value: string) => string
): Filter => {
  const condition = (name: string) =>
    values.length === 1
      ? `${name} = ${literal(values[0] ?? "")}`
      : `${name} in (${values.map(literal).join(", ")})`;

  return {
    apiCondition: condition(api),
    parameter: [api, values.join(",")],
  };
};

const comparison = (
  api: string,
  operator: Comparison,
  value: string,
  literal: (value: string) => string
): Filter => ({
  apiCondition: `${api} ${SYMBOLS[operator]} ${literal(value)}`,
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

/** A query: a collection, some filters and a sort. */
interface Query {
  readonly target: string;
  readonly filters: readonly Filter[];
  /** The sort in API names. */
  readonly sort: string;
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

const TYPES = ["AcmeAsset", "AcmeLaptop", "AcmeMonitor"];

const DATES = [
  "2023-03-10",
  "2024-06-01",
  "2025-01-15",
  "2025-02-01",
  "2025-03-01",
];

const classFilter = (types: readonly string[]): Filter => ({
  apiCondition: null,
  parameter: ["@type", types.join(",")],
});

const subset = <T>(values: readonly T[], maxLength = 2): Arbitrary<T[]> =>
  subarray([...values], { maxLength, minLength: 1 });

const costFilters = (hasCost: boolean): Arbitrary<Filter>[] =>
  hasCost
    ? [
        tuple(COMPARISONS, constantFrom(...COSTS)).map(([operator, value]) =>
          comparison("cost", operator, value, plain)
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
    subset(NAMES, 3).map((names) => equality("name", names, quoted)),
    subset(STATUSES).map((names) => equality("status", names, quoted)),
    tuple(COMPARISONS, constantFrom(...DATES)).map(([operator, value]) =>
      comparison("purchasedOn", operator, value, quoted)
    ),
    tuple(
      COMPARISONS,
      constantFrom(...values.dateTimes, ...values.dayOnly)
    ).map(([operator, value]) =>
      comparison("creationDate", operator, value, firstInstant)
    ),
    subset(values.users).map((ids) => equality("owner", ids, quoted)),
    subset(values.users).map((ids) => equality("owner.id", ids, quoted)),
    subset(["Alice monitor", "L"]).map((names) =>
      equality("dockedTo.name", names, quoted)
    ),
    subset(values.ids, 3).map((ids) => equality("id", ids, quoted)),
    subset(TYPES).map(classFilter),
    constantFrom("true", "false").map((flag) =>
      equality("flag", [flag], plain)
    ),
    tuple(COMPARISONS, constantFrom(...BIG_COUNTS)).map(([operator, value]) =>
      comparison("bigCount", operator, value, plain)
    ),
    ...costFilters(hasCost)
  );

const sizeFilters: Arbitrary<Filter>[] = [
  subset(SIZES, 3).map((sizes) => equality("sizeInches", sizes, plain)),
  tuple(COMPARISONS, constantFrom(...SIZES)).map(([operator, value]) =>
    comparison("sizeInches", operator, value, plain)
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
    subset(MONITOR_NAMES).map((names) => equality("name", names, quoted)),
    // Bob reads no monitor field beyond the asset's, so no size for him.
    ...(hasCost ? sizeFilters : []),
    ...costFilters(hasCost)
  );

const ALICE_ASSET_SORTS = [
  "name",
  "-cost",
  "purchasedOn",
  "-status,name",
  "creationDate,name",
] as const;

const BOB_ASSET_SORTS = ["name", "purchasedOn", "-status,name"] as const;

const BOB_MONITOR_SORTS = ["name"] as const;

const MONITOR_SORTS = ["name", "-sizeInches,name"] as const;

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
        target: API.asset,
      }));

      const monitors = tuple(
        distinctFilters(monitorFilter(hasCost)),
        constantFrom(...(hasCost ? MONITOR_SORTS : BOB_MONITOR_SORTS))
      ).map(([filters, sort]): Query => ({
        caller,
        filters,
        sort,
        target: API.monitor,
      }));

      return [assets, monitors];
    })
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
 * Runs one query as TMF parameters and as a condition.
 *
 * @param query - The query.
 * @param token - The caller's bearer token.
 * @returns The two responses.
 */
const observe = Effect.fn("TmfFilterEquivalence.observe")(function* observe(
  query: Query,
  token: string
) {
  const http = yield* TestHttpClient;

  return yield* Effect.all(
    {
      condition: http.get(
        withQuery(query.target, [
          ...conditionParameters(query.filters),
          ["sort", query.sort],
        ]),
        { token }
      ),
      tmf: http.get(
        withQuery(query.target, [
          ...query.filters.map((filter) => filter.parameter),
          ["sort", query.sort],
        ]),
        { token }
      ),
    },
    { concurrency: "unbounded" }
  );
});

/** What a property run saw. */
interface Tally {
  /** Samples that answered 200 on both surfaces and agreed. */
  successes: number;
  /** Of those, samples that found at least one record. */
  nonEmpty: number;
}

/**
 * Runs the generated queries; every sample must answer 200 on both
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
    const path = `${API.asset}/${id}`;
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
  const listed = yield* http.get(API.asset, { token });

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
      equality("name", ["S"], quoted).apiCondition,
      'name = "S"'
    );
    assert.strictEqual(
      equality("name", ["S", "K"], quoted).apiCondition,
      'name in ("S", "K")'
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "TMF filters and the condition syntax return the same IDs in the same order",
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
              withQuery(API.asset, [["name", name]]),
              { token }
            );

            const changed = yield* http.get(
              withQuery(API.asset, [["name", lowerCased(name)]]),
              { token }
            );

            const condition = yield* http.get(
              withQuery(API.asset, [
                ["condition", `name = ${quoted(lowerCased(name))}`],
              ]),
              { token }
            );

            assert.strictEqual(exact.status, 200);
            assert.lengthOf(idsOf(exact), 1, name);
            assert.strictEqual(changed.status, 200);
            assert.deepStrictEqual(idsOf(changed), [], name);
            assert.deepStrictEqual(idsOf(condition), idsOf(exact), name);
          }
        })
    );
  });

  layer(
    TestHttpClient.layer.pipe(
      Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
    ),
    {
      excludeTestServices: true,
    }
  )((dbTest) => {
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
              (keys) => equality("status", keys, quoted)
            ),
            subset(["critical", "high", "moderate", "low"], 3).map((keys) =>
              equality("priority", keys, quoted)
            ),
            subset(Object.values(records), 3).map((ids) =>
              equality("id", ids, quoted)
            ),
            subset(["HelpdeskTicket", "HelpdeskIncident"]).map(classFilter)
          );

          const queries = tuple(
            constantFrom("admin", "agent"),
            distinctFilters(filters),
            constantFrom("shortDescription", "-priority,shortDescription")
          ).map(([caller, drawn, sort]): Query => ({
            caller,
            filters: drawn,
            sort,
            target: "/api/v1/helpdeskTicket",
          }));

          const tally = yield* runSamples(queries, tokens);

          assert.strictEqual(tally.successes, RUNS);
          assert.isAbove(tally.nonEmpty, 0);
        }),
      { timeout: 300_000 }
    );
  });
});

/** A stored state combination of one ticket. */
interface StoredState {
  readonly status: string;
  readonly holdReason: string | null;
  readonly statusReason: string | null;
}

const NO_HOLD: readonly (string | null)[] = [
  null,
  "awaiting_caller",
  "awaiting_change",
  "awaiting_problem",
  "awaiting_vendor",
];

/** Every on-hold and canceled combination, which statuses can share. */
const HOLD_AND_CANCEL: readonly StoredState[] = [
  ...NO_HOLD.map((holdReason) => ({
    holdReason,
    status: "on_hold",
    statusReason: null,
  })),
  { holdReason: null, status: "canceled", statusReason: null },
  { holdReason: null, status: "canceled", statusReason: "rejected" },
  { holdReason: null, status: "canceled", statusReason: "duplicate" },
];

const plainStates = (statuses: readonly string[]): readonly StoredState[] => [
  ...statuses.map((status) => ({
    holdReason: null,
    status,
    statusReason: null,
  })),
  ...HOLD_AND_CANCEL,
];

const INCIDENT_STATES = plainStates([
  "new",
  "in_progress",
  "resolved",
  "closed",
]);

const PROBLEM_STATES = plainStates([
  "new",
  "assess",
  "root_cause_analysis",
  "fix_in_progress",
  "resolved",
  "closed",
]);

const TICKET_STATES = plainStates([
  "new",
  "in_progress",
  "awaiting_approval",
  "resolved",
  "closed",
]);

/**
 * Stored `ticket_type` values, which only a plain ticket renders,
 * `incident` and `problem` included (writable through `/api/v1` only):
 * `ticketType=incident` selects them with the incidents.
 */
const STORED_TYPES: readonly (string | null)[] = [
  null,
  "request",
  "ticket",
  "other",
  "Request",
  "incident",
  "problem",
];

const SEVERITY_LABELS: readonly (string | null)[] = [null, null, "Sev-X"];
const PRIORITY_LABELS: readonly (string | null)[] = [null, null, null, "P0"];
const TAG = "filter-equivalence";
const SEVERITIES = ["Critical", "Major", "Minor"];
const PRIORITIES = ["Critical", "High", "Medium", "Low", "Planning"];
const TICKET_TYPES = ["incident", "problem", "ticket", "other"];

const TMF621_STATUSES = [
  "acknowledged",
  "inProgress",
  "pending",
  "held",
  "resolved",
  "closed",
  "cancelled",
  "rejected",
] as const;

/**
 * Creates the tickets through `/api/v1` and stores their state
 * combinations, a `ticket_type`, and the free-text labels directly (the
 * stored shapes a read must render whatever way they came about).
 *
 * @returns Nothing.
 */
const seedTickets = Effect.fn("TmfFilterEquivalence.seedTickets")(
  function* seedTickets() {
    const tables = [
      ["helpdeskIncident", INCIDENT_STATES],
      ["helpdeskProblem", PROBLEM_STATES],
      ["helpdeskTicket", TICKET_STATES],
    ] as const;

    let index = 0;

    for (const [table, states] of tables) {
      for (const state of states) {
        const record = yield* createTicket(table, {
          impact: String((index % 3) + 1),
          priority: String((index % 5) + 1),
          shortDescription: TAG,
        });

        yield* sqlValues(
          `UPDATE helpdesk.ticket
             SET status = $2, hold_reason = $3, status_reason = $4,
                 ticket_type = $5, severity_label = $6, priority_label = $7
           WHERE id = $1::uuid`,
          [
            textOf(record.id),
            state.status,
            state.holdReason,
            state.statusReason,
            STORED_TYPES[index % STORED_TYPES.length],
            SEVERITY_LABELS[index % SEVERITY_LABELS.length],
            PRIORITY_LABELS[index % PRIORITY_LABELS.length],
          ]
        );
        index += 1;
      }
    }
  }
);

/**
 * The ids of the rendered tickets whose attribute equals a value.
 *
 * @param rendered - The unfiltered listing.
 * @param attribute - The attribute.
 * @param value - The value.
 * @returns The sorted ids.
 */
const idsWhere = (
  rendered: readonly JsonObject[],
  attribute: string,
  value: string
): readonly string[] =>
  rendered
    .flatMap((item) => (item[attribute] === value ? [textOf(item.id)] : []))
    .toSorted();

/**
 * The ids a `GET troubleTicket?<attribute>=<value>` returns, among the
 * test's tickets.
 *
 * @param admin - The client.
 * @param attribute - The attribute.
 * @param value - The value.
 * @returns The sorted ids.
 */
const idsFiltered = Effect.fn("TmfFilterEquivalence.idsFiltered")(
  function* idsFiltered(admin: Tmf621Client, attribute: string, value: string) {
    const response = yield* admin.get(
      `${TICKETS}?name=${TAG}&${attribute}=${encodeURIComponent(value)}&limit=1000`
    );

    assert.strictEqual(response.status, 200, response.text);

    return itemsOf(response)
      .map((item) => textOf(item.id))
      .toSorted();
  }
);

/**
 * Asserts that one attribute's filter selects exactly the tickets that
 * render each of the named values and each value rendered.
 *
 * @param admin - The client.
 * @param rendered - The unfiltered listing.
 * @param attribute - The attribute.
 * @param named - Values to check besides the rendered ones.
 * @returns Nothing.
 */
const assertFilterMatchesRendering = Effect.fn(
  "TmfFilterEquivalence.assertFilterMatchesRendering"
)(function* assertFilterMatchesRendering(
  admin: Tmf621Client,
  rendered: readonly JsonObject[],
  attribute: string,
  named: readonly string[]
) {
  const candidates = new Set([
    ...named,
    ...rendered.map((item) => textOf(item[attribute])),
  ]);

  const results = yield* Effect.all(
    [...candidates].map((value) =>
      Effect.map(idsFiltered(admin, attribute, value), (ids) => ({
        ids,
        value,
      }))
    ),
    { concurrency: "unbounded" }
  );

  for (const { ids, value } of results) {
    assert.deepStrictEqual(
      ids,
      idsWhere(rendered, attribute, value),
      `${attribute}=${value}`
    );
  }
});

describe("tmf-filter-equivalence-tmf621", () => {
  layer(itilLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "TMF621 status, severity, priority and ticketType filters select exactly the tickets whose rendered value they name",
      () =>
        Effect.gen(function* tmf621Filters() {
          const admin = yield* tmf621As("admin");

          yield* seedTickets();

          const listing = yield* admin.get(`${TICKETS}?name=${TAG}&limit=1000`);

          assert.strictEqual(listing.status, 200, listing.text);
          const rendered = itemsOf(listing);

          assert.lengthOf(
            rendered,
            INCIDENT_STATES.length +
              PROBLEM_STATES.length +
              TICKET_STATES.length
          );

          yield* assertFilterMatchesRendering(
            admin,
            rendered,
            "status",
            TMF621_STATUSES
          );
          yield* assertFilterMatchesRendering(
            admin,
            rendered,
            "severity",
            SEVERITIES
          );
          yield* assertFilterMatchesRendering(
            admin,
            rendered,
            "priority",
            PRIORITIES
          );
          yield* assertFilterMatchesRendering(
            admin,
            rendered,
            "ticketType",
            TICKET_TYPES
          );

          // The test is not vacuous: every status and ticketType value is
          // rendered by some ticket.
          for (const status of TMF621_STATUSES) {
            assert.isAbove(
              idsWhere(rendered, "status", status).length,
              0,
              status
            );
          }

          for (const type of TICKET_TYPES) {
            assert.isAbove(
              idsWhere(rendered, "ticketType", type).length,
              0,
              type
            );
          }
        }),
      { timeout: 120_000 }
    );
  });
});
