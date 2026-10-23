/**
 * `noninterference` (Contracts 3.3, 3.5): for generated filters, sorts and
 * cursors, randomize the values Bob cannot read, recompute every applicable
 * rule outcome, and keep only samples where no outcome changed; on those,
 * the IDs, order, count and present fields of Bob's responses are
 * unchanged.
 *
 * Values Bob cannot read: `cost` everywhere (rule 5), `purchased_on` of his
 * lost asset S (rule 6), `docked_to` where cost exceeds 2000 (rule 10),
 * `disk_key` and `size_inches` (no rule), and every field of Alice's
 * records, which he cannot see at all (rule 3). The rule outcomes that can
 * move are rule 10's `cost > 2000` per record; rules 3 and 6 read only
 * values Bob can read (`owner`, `status`), which stay fixed.
 *
 * Each sample applies the hidden values of one side, pages through the
 * generated query (so cursors are exercised), applies the other side's
 * values, pages again, and compares every page's exact body and its count
 * and cursor headers (`X-Total-Count`, `X-Result-Count`, and the `Link`
 * whose `after`/`before` cursors must carry only masked values).
 *
 * The API's `condition` text cannot name a class: `class` and `@type` are
 * not fields (UnknownField, or a syntax error), so the class predicate the
 * old test generated as an atom is not available inside the generated
 * AND/OR/NOT expressions. The class restriction is the top-level `@type`
 * filter instead.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  assert as check,
  boolean,
  constantFrom,
  integer,
  letrec,
  oneof,
  option,
  pre,
  record,
  string,
  subarray,
  tuple,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import type { AcmeData } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { listOf, listPath, readsTestLayer } from "./reads-support.ts";
import { values } from "./schema-support.ts";

const RUNS = 40;
const RULE_10_LIMIT = 2000;
const MAX_COST = 9999;
const MAX_SKIPS = 1000;
const SEED = 20_261_021;

/** Where S may be docked; `none` is no reference. */
type Dock = "none" | "AM" | "K" | "M";

/** The hidden values of one sample. */
interface Hidden {
  readonly costL: number;
  readonly costM: number;
  readonly costS: number;
  readonly costK: number;
  readonly purchasedS: string | null;
  readonly dockedS: Dock;
  readonly diskKeyL: string;
  readonly sizeM: number;
  readonly nameAM: string;
}

/** A generated read. */
interface Query {
  readonly condition: string | null;
  readonly sort: string;
  readonly limit: number;
  /** Restrict to `@type=AcmeLaptop` (`condition` cannot name a class). */
  readonly laptops: boolean;
}

const ATOMS = [
  'name = "L"',
  'status = "lost"',
  'status = "in_use"',
  'purchasedOn > "2024-01-01"',
  'purchasedOn < "2025-02-01"',
  "purchasedOn is empty",
  "dockedTo is empty",
  'dockedTo.name = "Alice monitor"',
  "owner = me",
  'name contains "M"',
] as const;

const CONDITION: Arbitrary<string> = letrec<{ condition: string }>((tie) => ({
  condition: oneof(
    { depthSize: "small", withCrossShrink: true },
    constantFrom(...ATOMS),
    tuple(tie("condition"), tie("condition")).map(
      ([left, right]) => `(${left}) and (${right})`
    ),
    tuple(tie("condition"), tie("condition")).map(
      ([left, right]) => `(${left}) or (${right})`
    ),
    tie("condition").map((inner) => `not (${inner})`)
  ),
})).condition;

const SORT_KEYS = [
  "name",
  "status",
  "purchasedOn",
  "dockedTo",
  "owner",
  "creationDate",
];

const directed = (keys: readonly string[], descending: readonly boolean[]) =>
  keys
    .map((key, index) => (descending[index] === true ? `-${key}` : key))
    .join(",");

const SORT = subarray(SORT_KEYS, { maxLength: 3 }).chain((keys) =>
  array(boolean(), { maxLength: keys.length, minLength: keys.length }).map(
    (descending) => directed(keys, descending)
  )
);

const QUERY: Arbitrary<Query> = record({
  condition: option(CONDITION, { nil: null }),
  laptops: boolean(),
  limit: integer({ max: 4, min: 1 }),
  sort: SORT,
});

const COST = integer({ max: MAX_COST, min: 0 });

const HIDDEN: Arbitrary<Hidden> = record({
  costK: COST,
  costL: COST,
  costM: COST,
  costS: COST,
  diskKeyL: string({ maxLength: 12, minLength: 1, unit: "grapheme-ascii" }),
  dockedS: constantFrom<Dock>("none", "AM", "K", "M"),
  nameAM: constantFrom("Alice monitor", "Other monitor", "zzz"),
  purchasedS: option(constantFrom("2020-01-01", "2024-06-30", "2025-12-31"), {
    nil: null,
  }),
  sizeM: integer({ max: 60, min: 10 }),
});

/**
 * Rule 10's outcome on Bob's three records: is cost above 2000?
 * @param hidden - A sample.
 * @returns The outcomes for L, M and S.
 */
const outcomes = (hidden: Hidden): readonly boolean[] =>
  [hidden.costL, hidden.costM, hidden.costS].map(
    (cost) => cost > RULE_10_LIMIT
  );

const sameOutcomes = (left: Hidden, right: Hidden): boolean => {
  const after = outcomes(right);

  return outcomes(left).every((outcome, index) => outcome === after[index]);
};

const queryParameters = (query: Query): Readonly<Record<string, string>> => {
  const base = query.laptops
    ? { "@type": "AcmeLaptop", limit: String(query.limit) }
    : { limit: String(query.limit) };

  const filtered =
    query.condition === null ? base : { ...base, condition: query.condition };

  return query.sort === "" ? filtered : { ...filtered, sort: query.sort };
};

/**
 * Applies one sample's hidden values, as table owner.
 * @param records - The fixture's records.
 * @param hidden - The values.
 * @returns Nothing.
 */
const applyHidden = Effect.fn("Noninterference.apply")(function* applyHidden(
  records: AcmeData["records"],
  hidden: Hidden
) {
  const docked = hidden.dockedS === "none" ? null : records[hidden.dockedS];

  yield* values(
    `UPDATE acme.asset SET cost = CASE id
       WHEN $1::uuid THEN $2::numeric WHEN $3::uuid THEN $4::numeric
       WHEN $5::uuid THEN $6::numeric WHEN $7::uuid THEN $8::numeric ELSE cost END,
     purchased_on = CASE WHEN id = $5::uuid THEN $9::date ELSE purchased_on END,
     docked_to = CASE WHEN id = $5::uuid THEN $10::uuid ELSE docked_to END,
     name = CASE WHEN id = $11::uuid THEN $12::text ELSE name END
     WHERE id IN ($1::uuid, $3::uuid, $5::uuid, $7::uuid, $11::uuid)
     RETURNING id::text AS value`,
    [
      records.L,
      String(hidden.costL),
      records.M,
      String(hidden.costM),
      records.S,
      String(hidden.costS),
      records.K,
      String(hidden.costK),
      hidden.purchasedS,
      docked,
      records.AM,
      hidden.nameAM,
    ]
  );
  yield* values(
    `UPDATE acme.laptop SET disk_key = $2::text WHERE id = $1::uuid RETURNING id::text AS value`,
    [records.L, hidden.diskKeyL]
  );
  yield* values(
    `UPDATE acme.monitor SET size_inches = $2::int4 WHERE id = $1::uuid RETURNING id::text AS value`,
    [records.M, String(hidden.sizeM)]
  );
});

/** One page as a caller sees it: the exact body and the count and cursor headers. */
interface Observed {
  readonly text: string;
  readonly total: string | null;
  readonly results: string | null;
  readonly link: string | null;
}

/**
 * Reads every page of a query, keeping each page's body and its
 * `X-Total-Count`, `X-Result-Count` and `Link` headers.
 * @param token - The session.
 * @param parameters - The query parameters (without `after`).
 * @returns The pages in order.
 */
const readPages = Effect.fn("Noninterference.readPages")(function* readPages(
  token: string,
  parameters: Readonly<Record<string, string>>
) {
  const http = yield* TestHttpClient;
  const pages: Observed[] = [];
  let after: string | undefined;

  do {
    const response = yield* http.get(
      listPath(
        "acme.asset",
        after === undefined ? parameters : { ...parameters, after }
      ),
      { token }
    );

    const page = yield* listOf(response);

    pages.push({
      link: response.headers.get("link"),
      results: response.headers.get("x-result-count"),
      text: response.text,
      total: response.headers.get("x-total-count"),
    });
    after = page.next;
  } while (after !== undefined);

  return pages;
});

/**
 * Applies both sides of a sample and reads every page after each.
 * @param token - Bob's session.
 * @param query - The read.
 * @param left - One side's hidden values.
 * @param right - The other side's.
 * @returns The page bodies under each side.
 */
const observeBoth = Effect.fn("Noninterference.observeBoth")(
  function* observeBoth(
    token: string,
    query: Query,
    left: Hidden,
    right: Hidden
  ) {
    const { records } = yield* AcmeFixture;
    const parameters = queryParameters(query);

    yield* applyHidden(records, left);
    const first = yield* readPages(token, parameters);
    yield* applyHidden(records, right);
    const second = yield* readPages(token, parameters);

    return { first, second };
  }
);

/**
 * The right side of a sample: `docked_to` on S is hidden only while rule
 * 10 holds there; otherwise Bob reads it, so it must not change.
 * @param left - One side.
 * @param candidate - The generated other side.
 * @returns The other side.
 */
const otherSide = (left: Hidden, candidate: Hidden): Hidden =>
  left.costS > RULE_10_LIMIT
    ? candidate
    : { ...candidate, dockedS: left.dockedS };

describe("noninterference", () => {
  it("compares rule 10 outcomes per record", () => {
    const base: Hidden = {
      costK: 1,
      costL: 1200,
      costM: 300,
      costS: 2500,
      diskKeyL: "x",
      dockedS: "none",
      nameAM: "Alice monitor",
      purchasedS: null,
      sizeM: 24,
    };

    assert.isTrue(sameOutcomes(base, { ...base, costS: 9000 }));
    assert.isFalse(sameOutcomes(base, { ...base, costS: 1500 }));
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "Bob's responses depend only on what he can read and on rule outcomes",
      () =>
        Effect.gen(function* noninterference() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");

          const services = yield* Effect.context<
            AcmeFixture | SqlClient.SqlClient | TestHttpClient
          >();

          const run = Effect.runPromiseWith(services);
          let compared = 0;

          const sample = async (
            query: Query,
            left: Hidden,
            candidate: Hidden
          ) => {
            pre(sameOutcomes(left, candidate));

            const observed = await run(
              observeBoth(token, query, left, otherSide(left, candidate)).pipe(
                Effect.orDie
              )
            );

            compared += 1;
            assert.deepStrictEqual(observed.second, observed.first);
          };

          yield* Effect.promise(async () => {
            await check(asyncProperty(QUERY, HIDDEN, HIDDEN, sample), {
              maxSkipsPerRun: MAX_SKIPS,
              numRuns: RUNS,
              seed: SEED,
            });
          });

          assert.isTrue(compared >= RUNS);
        }),
      { timeout: 300_000 }
    );
  });
});
