/**
 * The Contracts 3 acceptance tests through `/api/v1` (Step 3 gate):
 * the two-user example of 3.3 with TMF630 paths, API names and shapes,
 * alongside the standalone authorization, history and session suites.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { apiTableNameOf } from "@std/definitions/names";
import type { Operation } from "@std/definitions/operation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Context, Effect, Layer } from "effect";
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

import {
  ACME,
  AcmeFixture,
  createFixtureUser,
} from "../../testing/src/acme-fixture.ts";
import type { AcmeData } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { DEFINITION_KIND_OF_TABLE } from "../src/http/change-sets.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  asArray,
  asObject,
  idsOf,
  numberOf,
  API,
  apiCallers,
  withQuery,
} from "./api-support.ts";
import type { ApiCallers } from "./api-support.ts";
import {
  bulkRecords,
  CURSOR_ROWS as BULK_ROWS,
  CURSOR_SORTS as BULK_SORTS,
  deliveries,
  freshAsset,
  sequence,
} from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { allPagesV2, nextOf } from "./paging.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  ACME as SCHEMA_IDS,
  change,
  createRole,
  freshId,
  values,
} from "./schema-support.ts";

class SignedInCallers extends Context.Service<SignedInCallers, ApiCallers>()(
  "std/test/Contracts3Callers"
) {
  static readonly layer = Layer.effect(SignedInCallers, apiCallers);
}

const callersTestLayer = SignedInCallers.layer.pipe(
  Layer.provideMerge(readsTestLayer())
);

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

/**
 * Request options for a merge patch based on a revision.
 *
 * @param caller - The signed-in caller.
 * @param revision - The revision for `If-Match`.
 * @param body - The merge patch.
 * @returns The options.
 */
export const merge = (
  caller: TestRequestOptions,
  revision: number,
  body: JsonObject
): TestRequestOptions => ({
  ...caller,
  headers: {
    "content-type": "application/merge-patch+json",
    "if-match": `"${revision}"`,
  },
  rawBody: JSON.stringify(body),
});

const codeOf = (response: TestResponse) => asObject(response.json).code;

const revisionOf = Effect.fn("Contracts3V2.revisionOf")(function* revisionOf(
  path: string,
  caller: TestRequestOptions
) {
  const http = yield* TestHttpClient;

  return numberOf(asObject((yield* http.get(path, caller)).json).revision);
});

describe("contracts3", () => {
  it("merge sets If-Match to the quoted revision", () => {
    assert.strictEqual(
      merge({}, 3, { name: "x" }).headers?.["if-match"],
      '"3"'
    );
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "rows-count: Bob lists exactly his assets, counted, never with cost",
      () =>
        Effect.gen(function* rowsCount() {
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const { ids, texts, total } = yield* allPagesV2(
            withQuery(API.asset, [["limit", "2"]]),
            callers.bob
          );

          for (const text of texts) {
            assert.notInclude(text, '"cost"');
          }

          assert.sameMembers(ids, [records.L, records.M, records.S]);
          assert.strictEqual(total, "3");
        })
    );

    dbTest.effect(
      "hidden-names: a hidden field in a filter, sort or fields equals a missing one",
      () =>
        Effect.gen(function* hiddenNames() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;

          for (const [parameter, value] of [
            ["condition", "X > 0"],
            ["sort", "X"],
            ["fields", "X"],
            ["X.gt", "0"],
          ] as const) {
            const ask = (name: string) =>
              http.get(
                withQuery(API.asset, [
                  [parameter.replace("X", name), value.replace("X", name)],
                ]),
                callers.bob
              );

            const hidden = yield* ask("cost");
            const missing = yield* ask("nosuchfield");

            assert.strictEqual(hidden.status, 400, parameter);
            assert.strictEqual(codeOf(hidden), "UnknownField", parameter);
            assert.strictEqual(
              hidden.text.replaceAll("cost", "N"),
              missing.text.replaceAll("nosuchfield", "N"),
              parameter
            );
          }
        })
    );

    dbTest.effect(
      "invisible-404: Alice's laptop K is a 404 identical to a random ID",
      () =>
        Effect.gen(function* invisible() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const random = yield* http.get(
            `${API.laptop}/${RANDOM_ID}`,
            callers.bob
          );

          for (const path of [
            `${API.laptop}/${records.K}`,
            `${API.asset}/${records.K}`,
          ]) {
            const response = yield* http.get(path, callers.bob);

            assert.strictEqual(response.status, 404);
            assert.strictEqual(response.text, random.text);
          }

          const patched = yield* http.request(
            "PATCH",
            `${API.laptop}/${records.K}`,
            merge(callers.bob, 1, { name: "x" })
          );

          const patchedRandom = yield* http.request(
            "PATCH",
            `${API.laptop}/${RANDOM_ID}`,
            merge(callers.bob, 1, { name: "x" })
          );

          assert.strictEqual(patched.status, 404);
          assert.strictEqual(patched.text, patchedRandom.text);
        })
    );

    dbTest.effect(
      "masked-filter: a withheld date behaves as empty in TMF filters and conditions",
      () =>
        Effect.gen(function* maskedFilter() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const after = yield* http.get(
            withQuery(API.asset, [["purchasedOn.gt", "2000-01-01"]]),
            callers.bob
          );

          assert.notInclude(idsOf(after), records.S);

          const negated = yield* http.get(
            withQuery(API.asset, [
              ["condition", 'not (purchasedOn > "2000-01-01")'],
            ]),
            callers.bob
          );

          assert.include(idsOf(negated), records.S);
        })
    );

    dbTest.effect(
      "hidden-rule-input and references: dockedTo withheld on S, unlabelled on L; hops masked",
      () =>
        Effect.gen(function* hiddenRuleInput() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const lost = asObject(
            (yield* http.get(`${API.asset}/${records.S}`, callers.bob)).json
          );

          assert.include(asArray(lost.withheld), "dockedTo");

          const laptop = asObject(
            (yield* http.get(`${API.laptop}/${records.L}`, callers.bob)).json
          );

          assert.notProperty(asObject(laptop.dockedTo), "name");

          const bobHop = yield* http.get(
            withQuery(API.asset, [["dockedTo.name", "Alice monitor"]]),
            callers.bob
          );

          const aliceHop = yield* http.get(
            withQuery(API.asset, [["dockedTo.name", "Alice monitor"]]),
            callers.alice
          );

          assert.deepStrictEqual(idsOf(bobHop), []);
          assert.deepStrictEqual(idsOf(aliceHop), [records.L]);
        })
    );

    dbTest.effect(
      "child-fields: child-only fields are unknown through the parent",
      () =>
        Effect.gen(function* childFields() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const serial = yield* http.request(
            "PATCH",
            `${API.asset}/${records.L}`,
            merge(callers.bob, 1, { serial: "x" })
          );

          assert.strictEqual(codeOf(serial), "UnknownField");

          const diskKey = yield* http.request(
            "PATCH",
            `${API.laptop}/${records.L}`,
            merge(callers.bob, 1, { diskKey: "x" })
          );

          assert.strictEqual(codeOf(diskKey), "UnknownField");
        })
    );

    dbTest.effect("platform-tables: core.change is unknown to Bob in v2", () =>
      Effect.gen(function* platformTables() {
        const http = yield* TestHttpClient;
        const callers = yield* SignedInCallers;

        for (const path of ["/api/v1/coreChange", "/api/v1/coreAccessRule"]) {
          const response = yield* http.get(path, callers.bob);

          assert.strictEqual(response.status, 404, path);
          assert.strictEqual(codeOf(response), "UnknownTable", path);
        }

        const admin = yield* http.request("POST", "/api/v1/coreChange", {
          ...callers.admin,
          body: {},
        });

        assert.strictEqual(admin.status, 403);
        assert.strictEqual(codeOf(admin), "NotAllowed");
      })
    );

    dbTest.effect(
      "cookies: a cookie session needs STD-Client: web on unsafe v2 requests",
      () =>
        Effect.gen(function* cookies() {
          const http = yield* TestHttpClient;
          const token = yield* http.cookieSignIn("bob", "bob-password");

          const read = yield* http.get(API.asset, { cookie: token });

          assert.strictEqual(read.status, 200);

          const forged = yield* http.request("POST", API.asset, {
            body: { name: "x" },
            cookie: token,
            webClient: false,
          });

          assert.strictEqual(forged.status, 401);
          assert.strictEqual(codeOf(forged), "Unauthenticated");
        })
    );
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "ownership: Bob cannot give his laptop to Alice, nor create for her",
      () =>
        Effect.gen(function* ownership() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { alice, bob, records } = yield* AcmeFixture;
          const path = `${API.laptop}/${records.L}`;

          const given = yield* http.request(
            "PATCH",
            path,
            merge(callers.bob, 1, { owner: { id: alice.id } })
          );

          assert.strictEqual(given.status, 403);
          assert.strictEqual(codeOf(given), "NotAllowed");
          assert.strictEqual(yield* revisionOf(path, callers.bob), 1);

          const forAlice = yield* http.request("POST", API.asset, {
            ...callers.bob,
            body: { name: "x", owner: { id: alice.id } },
          });

          assert.strictEqual(forAlice.status, 403);

          const forBob = yield* http.request("POST", API.asset, {
            ...callers.bob,
            body: { name: "x", owner: { id: bob.id } },
          });

          assert.strictEqual(forBob.status, 201, forBob.text);
        })
    );

    dbTest.effect(
      "child-rule-parent-endpoint and written-fields: rule 9 through the parent; no-ops keep the revision",
      () =>
        Effect.gen(function* childRule() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const monitor = yield* http.request(
            "PATCH",
            `${API.asset}/${records.M}`,
            merge(callers.bob, 1, { status: "spare" })
          );

          assert.strictEqual(monitor.status, 200, monitor.text);

          const laptop = yield* http.request(
            "PATCH",
            `${API.asset}/${records.L}`,
            merge(callers.bob, 1, { status: "spare" })
          );

          assert.strictEqual(laptop.status, 403);

          // An unchanged readable field Bob may not write is accepted, and
          // the no-op keeps the revision.
          const unchanged = yield* http.request(
            "PATCH",
            `${API.laptop}/${records.L}`,
            merge(callers.bob, 1, { serial: "SN-L", status: "in_use" })
          );

          assert.strictEqual(unchanged.status, 200, unchanged.text);
          assert.strictEqual(asObject(unchanged.json).revision, 1);
        })
    );

    dbTest.effect(
      "references and referenced: hidden targets are InvalidReference like unknown IDs; a referenced record is kept",
      () =>
        Effect.gen(function* references() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const monitor = yield* revisionOf(
            `${API.monitor}/${records.M}`,
            callers.bob
          );

          const hidden = yield* http.request(
            "PATCH",
            `${API.monitor}/${records.M}`,
            merge(callers.bob, monitor, { dockedTo: { id: records.AM } })
          );

          const unknown = yield* http.request(
            "PATCH",
            `${API.monitor}/${records.M}`,
            merge(callers.bob, monitor, { dockedTo: { id: RANDOM_ID } })
          );

          assert.strictEqual(codeOf(hidden), "InvalidReference");
          assert.strictEqual(hidden.text, unknown.text);

          const referenced = yield* http.request(
            "DELETE",
            `${API.monitor}/${records.AM}`,
            { ...callers.alice, headers: { "if-match": '"1"' } }
          );

          assert.strictEqual(referenced.status, 409);
          assert.strictEqual(codeOf(referenced), "Referenced");
        })
    );

    dbTest.effect(
      "history: Bob sees Alice's status change on L through either endpoint, never cost",
      () =>
        Effect.gen(function* history() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const path = `${API.laptop}/${records.L}`;
          const revision = yield* revisionOf(path, callers.alice);

          const changed = yield* http.request(
            "PATCH",
            path,
            merge(callers.alice, revision, { cost: "1300.00", status: "spare" })
          );

          assert.strictEqual(changed.status, 200, changed.text);

          for (const endpoint of [API.laptop, API.asset]) {
            const entries = asArray(
              (yield* http.get(`${endpoint}/${records.L}/history`, callers.bob))
                .json
            ).map(asObject);

            const last = asObject(entries.at(-1)?.changes);

            assert.property(last, "status", endpoint);
            assert.notProperty(last, "cost", endpoint);
          }
        })
    );
  });
});

// ---- noninterference-v2 ------------------------------------------------

const NI_RUNS = 40;
const RULE_10_LIMIT = 2000;
const MAX_COST = 9999;
const MAX_SKIPS = 1000;
const NI_SEED = 20_261_022;

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

/** A generated v2 read: TMF filters, a `condition`, a sort and a page size. */
interface Query {
  readonly condition: string | null;
  readonly tmf: readonly (readonly [string, string])[];
  readonly sort: string;
  readonly limit: number;
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

const TMF_ATOMS: readonly (readonly [string, string])[] = [
  ["status", "lost"],
  ["status", "in_use"],
  ["purchasedOn.gt", "2024-01-01"],
  ["purchasedOn.lt", "2025-02-01"],
  ["dockedTo.name", "Alice monitor"],
  ["@type", "AcmeLaptop"],
  ["name", "L"],
];

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
  limit: integer({ max: 4, min: 1 }),
  sort: SORT,
  tmf: subarray([...TMF_ATOMS], { maxLength: 2 }),
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
 *
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

const queryOf = (query: Query): string => {
  const parameters: [string, string][] = [
    ["limit", String(query.limit)],
    ...query.tmf.map(([key, value]): [string, string] => [key, value]),
  ];

  if (query.condition !== null) {
    parameters.push(["condition", query.condition]);
  }

  if (query.sort !== "") {
    parameters.push(["sort", query.sort]);
  }

  return withQuery(API.asset, parameters);
};

/**
 * Applies one sample's hidden values, as table owner.
 *
 * @param records - The fixture's records.
 * @param hidden - The values.
 * @returns Nothing.
 */
const applyHidden = Effect.fn("Contracts3V2.applyHidden")(function* applyHidden(
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

const observeBoth = Effect.fn("Contracts3V2.observeBoth")(function* observeBoth(
  caller: TestRequestOptions,
  query: Query,
  left: Hidden,
  right: Hidden
) {
  const { records } = yield* AcmeFixture;
  const path = queryOf(query);

  yield* applyHidden(records, left);
  const first = yield* allPagesV2(path, caller);
  yield* applyHidden(records, right);
  const second = yield* allPagesV2(path, caller);

  return { first: first.texts, second: second.texts };
});

/**
 * The right side of a sample: `dockedTo` on S is hidden only while rule 10
 * holds there; otherwise Bob reads it, so it must not change.
 *
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

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "noninterference: Bob's v2 lists depend only on what he can read and on rule outcomes",
      () =>
        Effect.gen(function* noninterference() {
          const callers = yield* SignedInCallers;

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
              observeBoth(
                callers.bob,
                query,
                left,
                otherSide(left, candidate)
              ).pipe(Effect.orDie)
            );

            compared += 1;
            assert.deepStrictEqual(observed.second, observed.first);
          };

          yield* Effect.promise(async () => {
            await check(asyncProperty(QUERY, HIDDEN, HIDDEN, sample), {
              maxSkipsPerRun: MAX_SKIPS,
              numRuns: NI_RUNS,
              seed: NI_SEED,
            });
          });

          assert.isTrue(compared >= NI_RUNS);
        }),
      { timeout: 300_000 }
    );
  });
});

// ---- cursor-nulls-v2 ---------------------------------------------------

const BULK_PAGE = "7";

describe("cursor-nulls", () => {
  it("pages with after cursors from the Link header", () => {
    assert.strictEqual(
      nextOf('</api/v1/acmeAsset?after=abc&limit=7>; rel="next"'),
      "/api/v1/acmeAsset?after=abc&limit=7"
    );
    assert.strictEqual(nextOf(null), undefined);
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "cursor-nulls: 1,000 rows, half the sort keys hidden, paged 7 at a time with after cursors",
      () =>
        Effect.gen(function* cursorNulls() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const callers = yield* SignedInCallers;
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

          const condition = 'name starts with "bulk-"';

          for (const sort of BULK_SORTS) {
            const unpaged = yield* http.get(
              withQuery(API.asset, [
                ["condition", condition],
                ["limit", String(BULK_ROWS)],
                ["sort", sort],
              ]),
              callers.bob
            );

            const paged = yield* allPagesV2(
              withQuery(API.asset, [
                ["condition", condition],
                ["limit", BULK_PAGE],
                ["sort", sort],
              ]),
              callers.bob
            );

            const expected = idsOf(unpaged);

            assert.strictEqual(expected.length, BULK_ROWS, sort);
            assert.strictEqual(new Set(paged.ids).size, paged.ids.length, sort);
            assert.deepStrictEqual(paged.ids, expected, sort);

            if (sort === "purchasedOn") {
              // Hidden and empty keys are absent and sort last, ascending.
              const hidden = asArray(unpaged.json).map(
                (item) => !("purchasedOn" in asObject(item))
              );

              const firstHidden = hidden.indexOf(true);

              assert.isTrue(firstHidden > 0);
              assert.isTrue(hidden.slice(firstHidden).every(Boolean));
            }

            if (sort === "-purchasedOn") {
              // Descending sorts hidden and empty keys first.
              const hidden = asArray(unpaged.json).map(
                (item) => !("purchasedOn" in asObject(item))
              );

              const lastHidden = hidden.lastIndexOf(true);

              assert.isTrue(lastHidden !== -1);
              assert.isTrue(hidden.slice(0, lastHidden + 1).every(Boolean));
            }
          }
        }),
      { timeout: 120_000 }
    );
  });
});

// ---- hidden-rule-input-v2, written-fields, field-rule-states ------------

const RULE_7 = "71fc933a-24a4-4573-8c96-13eb2650dc10";
const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const OWNER_FIELD = "6a373fb5-bd18-4d7f-b0b4-182470f5421e";
const DOCKED_TO_FIELD = "83ec3835-6898-46f3-ae2e-afdbc3f5d407";

/**
 * Rule 7 without `name`, and an allow of `name` for employees conditioned
 * on `status = "in_use"` (Contracts 3 `field-rule-states`).
 */
const replaceRule7ForName = Effect.gen(function* replaceRule7() {
  const snapshot = yield* (yield* Catalog).refresh;
  const rule = snapshot.getKind("accessRule", RULE_7);

  if (rule === undefined) {
    return yield* Effect.die(new Error("rule 7 is missing"));
  }

  const operations: Operation[] = [
    {
      changes: {
        target: {
          fields: [SCHEMA_IDS.status, OWNER_FIELD, DOCKED_TO_FIELD],
          kind: "fields",
        },
      },
      id: RULE_7,
      op: "update",
      version: rule.version,
    },
    {
      definition: {
        actions: ["create", "update"],
        active: true,
        classId: SCHEMA_IDS.asset,
        condition: {
          left: { path: [SCHEMA_IDS.status] },
          op: "eq",
          right: { value: "in_use" },
        },
        description: "employees may write name while in use",
        effect: "allow",
        id: randomUUID(),
        kind: "accessRule",
        name: null,
        owner: { layer: "local" },
        protected: false,
        roleIds: [EMPLOYEE],
        target: { fields: [SCHEMA_IDS.name], kind: "fields" },
      },
      op: "createAccessRule",
    },
  ];

  return yield* change(operations);
});

const withoutWithheld = (resource: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(resource).filter(([key]) => key !== "withheld")
  );

describe("hidden-rule-input", () => {
  it("compares a record without its withheld list", () => {
    assert.deepStrictEqual(withoutWithheld({ id: "x", withheld: ["a"] }), {
      id: "x",
    });
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "hidden-rule-input: rule 10 reads cost; only whether dockedTo is withheld changes",
      () =>
        Effect.gen(function* hiddenRuleInput() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const read = () => http.get(`${API.asset}/${records.S}`, callers.bob);

          const setCost = (cost: string) =>
            values(
              `UPDATE acme.asset SET cost = $1::numeric WHERE id = $2::uuid RETURNING id::text AS value`,
              [cost, records.S]
            );

          const before = yield* read();
          const lost = asObject(before.json);

          const laptop = asObject(
            (yield* http.get(`${API.asset}/${records.L}`, callers.bob)).json
          );

          assert.include(asArray(lost.withheld), "dockedTo");
          assert.notProperty(lost, "dockedTo");
          assert.notInclude(asArray(laptop.withheld), "dockedTo");
          assert.strictEqual(asObject(laptop.dockedTo).id, records.AM);

          // Anywhere above 2000 changes nothing Bob sees.
          yield* setCost("9999.99");
          assert.strictEqual((yield* read()).text, before.text);
          yield* setCost("2000.01");
          assert.strictEqual((yield* read()).text, before.text);

          // At 1500 only the one withheld bit changes.
          yield* setCost("1500");
          const cheap = asObject((yield* read()).json);

          assert.deepStrictEqual(
            asArray(cheap.withheld),
            asArray(lost.withheld).filter((name) => name !== "dockedTo")
          );
          assert.deepStrictEqual(withoutWithheld(cheap), withoutWithheld(lost));
        })
    );
  });
});

describe("written-fields", () => {
  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "written-fields: unchanged readable fields are accepted; no-ops keep the revision; hidden values answer alike",
      () =>
        Effect.gen(function* writtenFields() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const laptop = `${API.laptop}/${records.L}`;
          const lost = `${API.asset}/${records.S}`;
          const revision = yield* revisionOf(laptop, callers.bob);

          // serial is readable to Bob but not writable; unchanged it is
          // not written.
          const unchanged = yield* http.request(
            "PATCH",
            laptop,
            merge(callers.bob, revision, { name: "L renamed", serial: "SN-L" })
          );

          assert.strictEqual(unchanged.status, 200, unchanged.text);
          assert.strictEqual(
            yield* revisionOf(laptop, callers.bob),
            revision + 1
          );

          const noOp = yield* http.request(
            "PATCH",
            laptop,
            merge(callers.bob, revision + 1, { name: "L renamed" })
          );

          assert.strictEqual(noOp.status, 200, noOp.text);
          assert.strictEqual(
            yield* revisionOf(laptop, callers.bob),
            revision + 1
          );

          // purchasedOn is hidden on lost S: an equal value and a different
          // one have the same status, body and version effect.
          const lostRevision = yield* revisionOf(lost, callers.bob);

          const equal = yield* http.request(
            "PATCH",
            lost,
            merge(callers.bob, lostRevision, { purchasedOn: "2023-03-10" })
          );

          const different = yield* http.request(
            "PATCH",
            lost,
            merge(callers.bob, lostRevision, { purchasedOn: "2020-01-01" })
          );

          assert.strictEqual(equal.status, different.status);
          assert.strictEqual(equal.text, different.text);
          assert.strictEqual(
            yield* revisionOf(lost, callers.bob),
            lostRevision
          );
        })
    );
  });
});

describe("field-rule-states", () => {
  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "field-rule-states: with rule 7 replaced for name, both the existing and the proposed state must pass",
      () =>
        Effect.gen(function* fieldRuleStates() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const path = `${API.asset}/${records.M}`;

          const patch = (revision: number, body: JsonObject) =>
            http.request("PATCH", path, merge(callers.bob, revision, body));

          yield* replaceRule7ForName;

          const revision = yield* revisionOf(path, callers.bob);

          const leaving = yield* patch(revision, {
            name: "M leaving",
            status: "spare",
          });

          assert.strictEqual(leaving.status, 403, "proposed state fails");
          assert.strictEqual(codeOf(leaving), "NotAllowed");

          const spare = yield* patch(revision, { status: "spare" });

          assert.strictEqual(spare.status, 200, spare.text);

          const returning = yield* patch(revision + 1, {
            name: "M back",
            status: "in_use",
          });

          assert.strictEqual(returning.status, 403, "existing state fails");

          const inUse = yield* patch(revision + 1, { status: "in_use" });

          assert.strictEqual(inUse.status, 200, inUse.text);

          const nameOnly = yield* patch(revision + 2, { name: "M renamed" });

          assert.strictEqual(nameOnly.status, 200, nameOnly.text);
        })
    );
  });
});

// ---- two-user-write, history, history-endpoint, references, referenced ---

const revisions = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

describe("two-user-write", () => {
  it("numbers revisions from 1", () => {
    assert.deepStrictEqual(revisions(3), [1, 2, 3]);
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "two-user-write: Bob and Alice write L through different endpoints at revisions n, n+1, n+2",
      () =>
        Effect.gen(function* twoUserWrite() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const laptop = `${API.laptop}/${records.L}`;
          const asset = `${API.asset}/${records.L}`;
          const n = yield* revisionOf(laptop, callers.bob);

          const bobRename = yield* http.request(
            "PATCH",
            laptop,
            merge(callers.bob, n, { name: "L by Bob" })
          );

          assert.strictEqual(bobRename.status, 200, bobRename.text);
          assert.strictEqual(asObject(bobRename.json).revision, n + 1);

          // Alice holds revision n and gets VersionConflict; nothing changes.
          const stale = yield* http.request(
            "PATCH",
            asset,
            merge(callers.alice, n, { cost: "1300.00" })
          );

          assert.strictEqual(stale.status, 412, stale.text);
          assert.strictEqual(codeOf(stale), "VersionConflict");
          assert.strictEqual(yield* revisionOf(asset, callers.alice), n + 1);

          // Alice rereads through the parent and writes cost at n+1.
          const reread = yield* revisionOf(asset, callers.alice);

          const aliceCost = yield* http.request(
            "PATCH",
            asset,
            merge(callers.alice, reread, { cost: "1300.00" })
          );

          assert.strictEqual(aliceCost.status, 200, aliceCost.text);
          assert.strictEqual(asObject(aliceCost.json).revision, n + 2);

          // Rule 9 refuses Bob's status through both endpoints.
          for (const path of [laptop, asset]) {
            const refused = yield* http.request(
              "PATCH",
              path,
              merge(callers.bob, n + 2, { status: "spare" })
            );

            assert.strictEqual(refused.status, 403, path);
            assert.strictEqual(codeOf(refused), "NotAllowed", path);
          }

          // The laptop override makes purchasedOn required, also through
          // the parent.
          const purchased = yield* http.request(
            "PATCH",
            asset,
            merge(callers.alice, n + 2, { purchasedOn: null })
          );

          assert.strictEqual(purchased.status, 422, purchased.text);
          assert.strictEqual(codeOf(purchased), "ValidationFailed");
          assert.strictEqual(yield* revisionOf(asset, callers.alice), n + 2);

          // Each user's history through both endpoints: exactly 1..n+2, and
          // a cost change only for Alice.
          for (const [caller, isBob] of [
            [callers.alice, false],
            [callers.bob, true],
          ] as const) {
            for (const endpoint of [API.laptop, API.asset]) {
              const entries = asArray(
                (yield* http.get(`${endpoint}/${records.L}/history`, caller))
                  .json
              ).map(asObject);

              assert.deepStrictEqual(
                entries.map((entry) => entry.revision),
                revisions(n + 2),
                endpoint
              );
              assert.strictEqual(
                entries.some((entry) => "cost" in asObject(entry.changes)),
                !isBob,
                endpoint
              );
            }
          }
        })
    );
  });
});

const changesAt = (entries: readonly JsonObject[], revision: number) =>
  entries.find((candidate) => candidate.revision === revision)?.changes;

const bodyObject = (response: TestResponse): JsonObject =>
  asObject(response.json);

describe("history", () => {
  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "history and history-endpoint: Bob sees the status and serial changes through either endpoint, never cost",
      () =>
        Effect.gen(function* histories() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;
          const path = `${API.laptop}/${records.L}`;
          const n = yield* revisionOf(path, callers.alice);

          const costAndStatus = yield* http.request(
            "PATCH",
            `${API.asset}/${records.L}`,
            merge(callers.alice, n, { cost: "1250.00", status: "repair" })
          );

          assert.strictEqual(costAndStatus.status, 200, costAndStatus.text);

          const serial = yield* http.request(
            "PATCH",
            path,
            merge(callers.alice, n + 1, { serial: "SN-L2" })
          );

          assert.strictEqual(serial.status, 200, serial.text);

          for (const endpoint of [API.asset, API.laptop]) {
            const entries = asArray(
              (yield* http.get(`${endpoint}/${records.L}/history`, callers.bob))
                .json
            ).map(asObject);

            const entry = (revision: number) =>
              asObject(changesAt(entries, revision));

            assert.deepStrictEqual(Object.keys(entry(n + 1)), ["status"]);
            assert.include(JSON.stringify(entry(n + 1)), "repair");
            assert.deepStrictEqual(Object.keys(entry(n + 2)), ["serial"]);
            assert.include(JSON.stringify(entry(n + 2)), "SN-L2");
            assert.isTrue(
              entries.every(
                (candidate) => !("cost" in asObject(candidate.changes))
              )
            );
          }

          const aliceSees = asArray(
            (yield* http.get(
              `${API.asset}/${records.L}/history`,
              callers.alice
            )).json
          ).map(asObject);

          assert.property(
            asObject(
              aliceSees.find((entry) => entry.revision === n + 1)?.changes
            ),
            "cost"
          );
        })
    );
  });
});

describe("references", () => {
  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "references: Bob sees dockedTo without a label, Alice with one; a hidden target is InvalidReference on update and create alike",
      () =>
        Effect.gen(function* references() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { bob, records } = yield* AcmeFixture;

          const asBob = asObject(
            (yield* http.get(`${API.asset}/${records.L}`, callers.bob)).json
          );

          const asAlice = asObject(
            (yield* http.get(`${API.asset}/${records.L}`, callers.alice)).json
          );

          assert.strictEqual(asObject(asBob.dockedTo).id, records.AM);
          assert.notProperty(asObject(asBob.dockedTo), "name");
          assert.strictEqual(asObject(asBob.owner).name, "Bob");
          assert.strictEqual(asObject(asAlice.dockedTo).name, "Alice monitor");

          for (const [caller, expected] of [
            [callers.bob, []],
            [callers.alice, [records.L]],
          ] as const) {
            const hop = yield* http.get(
              withQuery(API.asset, [["dockedTo.name", "Alice monitor"]]),
              caller
            );

            assert.deepStrictEqual(idsOf(hop), [...expected]);
          }

          const path = `${API.asset}/${records.M}`;
          const revision = yield* revisionOf(path, callers.bob);

          const hidden = yield* http.request(
            "PATCH",
            path,
            merge(callers.bob, revision, { dockedTo: { id: records.AM } })
          );

          const unknown = yield* http.request(
            "PATCH",
            path,
            merge(callers.bob, revision, { dockedTo: { id: RANDOM_ID } })
          );

          assert.strictEqual(hidden.status, 422);
          assert.strictEqual(codeOf(hidden), "InvalidReference");
          assert.strictEqual(hidden.text, unknown.text);

          const created = yield* http.request("POST", API.asset, {
            ...callers.bob,
            body: {
              dockedTo: { id: records.AM },
              name: "dock",
              owner: { id: bob.id },
            },
          });

          assert.strictEqual(created.text, hidden.text);
          assert.strictEqual(yield* revisionOf(path, callers.bob), revision);
        })
    );

    dbTest.effect(
      "referenced: deleting a referenced monitor is refused without an ID or count, and the monitor remains",
      () =>
        Effect.gen(function* referenced() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const refused = yield* http.request(
            "DELETE",
            `${API.monitor}/${records.AM}`,
            { ...callers.alice, headers: { "if-match": '"1"' } }
          );

          assert.strictEqual(refused.status, 409);
          assert.strictEqual(codeOf(refused), "Referenced");
          assert.notInclude(refused.text, records.L);
          assert.notInclude(refused.text, records.AM);
          assert.notMatch(refused.text, /\bcount\b/u);

          const still = yield* http.get(
            `${API.monitor}/${records.AM}`,
            callers.alice
          );

          assert.strictEqual(still.status, 200);
        })
    );
  });
});

// ---- users, platform-tables, no-bypass, invisible-identity ---------------

const USER_COLLECTION = API.user;

const userRevision = (id: string) =>
  values(`SELECT version::text AS value FROM core."user" WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([version]) => Number(version ?? "0")));

describe("users", () => {
  it("names the user collection", () => {
    assert.strictEqual(USER_COLLECTION, "/api/v1/coreUser");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "users: admin deleting a user gets 403 through the built-in deny",
      () =>
        Effect.gen(function* deleteRefused() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { admin, alice, bob, carol } = yield* AcmeFixture;

          for (const user of [bob, carol, admin]) {
            const revision = yield* userRevision(user.id);

            const response = yield* http.request(
              "DELETE",
              `${USER_COLLECTION}/${user.id}`,
              { ...callers.admin, headers: { "if-match": `"${revision}"` } }
            );

            assert.strictEqual(response.status, 403, response.text);
            assert.strictEqual(codeOf(response), "NotAllowed");
            assert.strictEqual(yield* userRevision(user.id), revision);
          }

          // Bob sees users, so his delete is refused the same way.
          const byBob = yield* http.request(
            "DELETE",
            `${USER_COLLECTION}/${alice.id}`,
            { ...callers.bob, headers: { "if-match": '"1"' } }
          );

          assert.strictEqual(byBob.status, 403);
          assert.strictEqual(codeOf(byBob), "NotAllowed");
        })
    );

    dbTest.effect(
      "users: deactivation ends sessions, refuses sign-in and keeps labels (the empty role set is code-level: users.test.ts)",
      () =>
        Effect.gen(function* deactivate() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { alice, bob, carol, records } = yield* AcmeFixture;

          // A record Bob created, owned by Alice: Alice reads its labels
          // after Bob is gone.
          const created = yield* freshAsset(bob.id, ACME.monitor, {
            name: "made by Bob",
          }).pipe(
            Effect.andThen((id) =>
              values(
                `UPDATE acme.asset SET owner = $2::uuid WHERE id = $1::uuid RETURNING id::text AS value`,
                [id, alice.id]
              )
            ),
            Effect.map(([id]) => id ?? "")
          );

          const deactivated = yield* http.request(
            "PATCH",
            `${USER_COLLECTION}/${bob.id}`,
            merge(callers.admin, yield* userRevision(bob.id), { active: false })
          );

          assert.strictEqual(deactivated.status, 200, deactivated.text);

          // Sessions end.
          const used = yield* http.get(API.asset, callers.bob);

          assert.strictEqual(used.status, 401);
          assert.strictEqual(codeOf(used), "Unauthenticated");
          assert.deepStrictEqual(
            yield* values(
              `SELECT count(*)::text AS value FROM core."session" WHERE user_id = $1::uuid`,
              [bob.id]
            ),
            ["0"]
          );

          // Sign-in is refused like a wrong password.
          const signIn = yield* http.request("POST", "/api/v1/session", {
            body: { login: "bob", password: "bob-password" },
          });

          const wrong = yield* http.request("POST", "/api/v1/session", {
            body: { login: "alice", password: "wrong" },
          });

          assert.strictEqual(signIn.status, 401);
          assert.strictEqual(codeOf(signIn), "InvalidCredentials");
          assert.strictEqual(signIn.text, wrong.text);

          // Labels still resolve: L's owner, and the audit fields.
          const read = (path: string) =>
            http.get(path, callers.alice).pipe(Effect.map(bodyObject));

          const laptop = yield* read(`${API.asset}/${records.L}`);

          assert.strictEqual(asObject(laptop.owner).name, "Bob");
          assert.strictEqual(asObject(laptop.createdBy).name, "Bob");

          const madeByBob = yield* read(`${API.monitor}/${created}`);

          assert.strictEqual(asObject(madeByBob.createdBy).name, "Bob");
          assert.strictEqual(asObject(madeByBob.updatedBy).name, "Bob");

          // Carol was created deactivated; her name still labels.
          const byCarol = yield* freshAsset(carol.id, ACME.asset, {
            name: "made by Carol",
          });

          const carolsAsset = yield* read(`${API.asset}/${byCarol}`);

          assert.strictEqual(asObject(carolsAsset.owner).name, "Carol");
          assert.strictEqual(asObject(carolsAsset.createdBy).name, "Carol");

          // And user names are listed for every user, inactive ones too.
          const users = yield* http.get(
            withQuery(USER_COLLECTION, [["name", "Bob"]]),
            callers.alice
          );

          assert.strictEqual(users.status, 200);
          assert.deepStrictEqual(idsOf(users), [bob.id]);

          // Reactivation revives no session; Bob signs in again.
          const reactivated = yield* http.request(
            "PATCH",
            `${USER_COLLECTION}/${bob.id}`,
            merge(callers.admin, yield* userRevision(bob.id), { active: true })
          );

          assert.strictEqual(reactivated.status, 200, reactivated.text);

          const stillEnded = yield* http.get(
            "/api/v1/session/current",
            callers.bob
          );

          assert.strictEqual(stillEnded.status, 401);

          const again = yield* http.signIn("bob", "bob-password");

          assert.strictEqual(
            (yield* http.get("/api/v1/session/current", { token: again }))
              .status,
            200
          );
        })
    );

    dbTest.effect(
      "users: admins create users; the password is never returned; Bob cannot rename himself",
      () =>
        Effect.gen(function* createUser() {
          const http = yield* TestHttpClient;
          const callers = yield* apiCallers;
          const { bob } = yield* AcmeFixture;

          const created = yield* http.request("POST", USER_COLLECTION, {
            ...callers.admin,
            body: {
              active: true,
              login: "dave",
              name: "Dave",
              password: "dave-password",
            },
          });

          assert.strictEqual(created.status, 201, created.text);
          assert.notInclude(created.text, "dave-password");
          assert.strictEqual(asObject(created.json)["@type"], "CoreUser");

          const token = yield* http.signIn("dave", "dave-password");
          const me = yield* http.get("/api/v1/session/current", { token });

          assert.strictEqual(me.status, 200);
          assert.strictEqual(asObject(me.json).name, "Dave");

          const own = yield* http.request(
            "PATCH",
            `${USER_COLLECTION}/${bob.id}`,
            merge(callers.bob, yield* userRevision(bob.id), { name: "Bobby" })
          );

          assert.strictEqual(own.status, 403);
          assert.strictEqual(codeOf(own), "NotAllowed");
        })
    );
  });
});

// ---- platform-tables-v2 ----------------------------------------------------

/** Config tables that are not platform tables but hold no data for users. */
const CONFIG_TABLES = ["core.user_role"] as const;

const MISSING = "core.no_such_table";

/**
 * A qualified table name's v2 collection (`core.access_rule` is
 * `coreAccessRule`).
 *
 * @param table - The qualified name.
 * @returns The collection name.
 */
const collectionOf = (table: string): string => {
  const [namespace = "", name = ""] = table.split(".");

  return apiTableNameOf(namespace, name);
};

const platformTables = (snapshot: ConfigSnapshot): string[] =>
  snapshot
    .all("class")
    .filter((definition) => definition.storage === "platform")
    .map((definition) => snapshot.qualifiedNameOf(definition.id) ?? "");

const coreSchemaTables = () =>
  values(
    `SELECT 'core.' || c.relname AS value FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`
  );

const internalTables = (snapshot: ConfigSnapshot) =>
  coreSchemaTables().pipe(
    Effect.map((tables) => {
      const described = new Set(
        snapshot
          .all("class")
          .map((definition) => snapshot.qualifiedNameOf(definition.id))
      );

      return tables.filter((table) => !described.has(table));
    })
  );

const REVISION_ONE = '"1"';

/**
 * Every by-ID route of a v2 collection, as method, path and request
 * options for a caller.
 *
 * @param collection - The collection name.
 * @param caller - The caller.
 * @returns The routes.
 */
const routesOf = (collection: string, caller: TestRequestOptions) => {
  const path = `/api/v1/${collection}`;
  const one = `${path}/${RANDOM_ID}`;

  return [
    ["GET", path, caller],
    ["GET", one, caller],
    ["GET", `${one}/history`, caller],
    ["POST", path, { ...caller, body: { name: "x" } }],
    [
      "PATCH",
      one,
      {
        ...caller,
        headers: {
          "content-type": "application/merge-patch+json",
          "if-match": REVISION_ONE,
        },
        rawBody: JSON.stringify({ name: "x" }),
      },
    ],
    ["DELETE", one, { ...caller, headers: { "if-match": REVISION_ONE } }],
  ] as const;
};

const unknownOnEveryRoute = Effect.fn("Contracts3V2.unknownOnEveryRoute")(
  function* unknownOnEveryRoute(
    caller: TestRequestOptions,
    table: string,
    label: string
  ) {
    const http = yield* TestHttpClient;
    const collection = collectionOf(table);
    const missingRoutes = routesOf(collectionOf(MISSING), caller);

    for (const [index, [method, path, options]] of routesOf(
      collection,
      caller
    ).entries()) {
      const response = yield* http.request(method, path, options);

      const [, missingPath = "", missingOptions = {}] =
        missingRoutes[index] ?? [];

      const missing = yield* http.request(method, missingPath, missingOptions);
      const where = `${label} ${method} ${path}`;

      assert.strictEqual(response.status, 404, where);
      assert.strictEqual(codeOf(response), "UnknownTable", where);
      assert.strictEqual(
        response.text.replaceAll(collection, "?"),
        missing.text.replaceAll(collectionOf(MISSING), "?"),
        where
      );
    }
  }
);

const changeCount = () =>
  values(`SELECT count(*)::text AS value FROM core."change"`);

describe("platform-tables", () => {
  it("names a table's collection in lowerCamelCase", () => {
    assert.strictEqual(collectionOf("core.access_rule"), "coreAccessRule");
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "platform-tables: Bob's coreChange and coreAccessRule are UnknownTable, like a missing table",
      () =>
        Effect.gen(function* bobsView() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;

          const missing = yield* http.get(
            `/api/v1/${collectionOf(MISSING)}`,
            callers.bob
          );

          for (const table of ["core.change", "core.access_rule"]) {
            const collection = collectionOf(table);

            const response = yield* http.get(
              `/api/v1/${collection}`,
              callers.bob
            );

            assert.strictEqual(response.status, 404, table);
            assert.strictEqual(codeOf(response), "UnknownTable");
            assert.strictEqual(
              response.text.replaceAll(collection, "?"),
              missing.text.replaceAll(collectionOf(MISSING), "?")
            );
          }
        })
    );

    dbTest.effect(
      "platform-tables: every platform, config and internal table is unknown on every route to every non-admin",
      () =>
        Effect.gen(function* everyTable() {
          const callers = yield* SignedInCallers;
          const snapshot = yield* (yield* Catalog).refresh;
          const platform = platformTables(snapshot);

          assert.sameMembers(
            platform,
            Object.keys(PLATFORM_CLASS_IDS).map((name) => `core.${name}`)
          );

          const internal = yield* internalTables(snapshot);

          assert.includeMembers(internal, ["core.session", "core.delivery"]);

          for (const [who, caller] of [
            ["alice", callers.alice],
            ["bob", callers.bob],
          ] as const) {
            for (const table of [...platform, ...CONFIG_TABLES, ...internal]) {
              yield* unknownOnEveryRoute(caller, table, who);
            }
          }

          // Tables no definition describes are unknown to admins too.
          for (const table of internal) {
            yield* unknownOnEveryRoute(callers.admin, table, "admin");
          }
        })
    );

    dbTest.effect(
      "platform-tables: admins read platform tables, refuse journal writes and validate stored actions",
      () =>
        Effect.gen(function* adminWrites() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const caller = callers.admin;

          const changes = yield* http.get(
            withQuery("/api/v1/coreChange", [["limit", "1"]]),
            caller
          );

          assert.strictEqual(changes.status, 200, changes.text);

          const [changeId = ""] = yield* values(
            `SELECT id::text AS value FROM core."change" ORDER BY id LIMIT 1`
          );

          const [ruleId = "", ruleVersion = "1"] = yield* values(
            `SELECT unnest(ARRAY[id::text, version::text]) AS value
               FROM (SELECT id, version FROM core.access_rule ORDER BY id LIMIT 1) AS r`
          );

          const ruleText = () =>
            values(
              `SELECT row_to_json(r)::text AS value FROM core.access_rule AS r WHERE id = $1::uuid`,
              [ruleId]
            );

          const ruleBefore = yield* ruleText();
          const before = yield* changeCount();
          const deliveriesBefore = yield* deliveries();

          // `coreChange` is refused for every caller. A write to a
          // definition table is a change set (Contracts 1.4), as in v1: an
          // incomplete create is ValidationFailed, and the built-in rules
          // are protected.
          const writes = [
            [
              "POST",
              "/api/v1/coreChange",
              { ...caller, body: { kind: "update" } },
              403,
              "NotAllowed",
            ],
            [
              "PATCH",
              `/api/v1/coreChange/${changeId}`,
              merge(caller, 1, { kind: "delete" }),
              403,
              "NotAllowed",
            ],
            [
              "DELETE",
              `/api/v1/coreChange/${changeId}`,
              { ...caller, headers: { "if-match": REVISION_ONE } },
              403,
              "NotAllowed",
            ],
            [
              "POST",
              "/api/v1/coreAccessRule",
              { ...caller, body: { description: "forged" } },
              422,
              "ValidationFailed",
            ],
            [
              "PATCH",
              `/api/v1/coreAccessRule/${ruleId}`,
              merge(caller, Number(ruleVersion), { description: "edited" }),
              403,
              "DefinitionProtected",
            ],
            [
              "DELETE",
              `/api/v1/coreAccessRule/${ruleId}`,
              { ...caller, headers: { "if-match": `"${ruleVersion}"` } },
              403,
              "DefinitionProtected",
            ],
          ] as const;

          for (const [method, path, options, status, code] of writes) {
            const response = yield* http.request(method, path, options);

            assert.strictEqual(response.status, status, `${method} ${path}`);
            assert.strictEqual(codeOf(response), code, `${method} ${path}`);
          }

          // A create on every platform table the catalog describes.
          const snapshot = yield* (yield* Catalog).refresh;

          for (const table of platformTables(snapshot)) {
            const response = yield* http.request(
              "POST",
              `/api/v1/${collectionOf(table)}`,
              { ...caller, body: {} }
            );

            // An empty create on a definition table is an incomplete
            // change set (ValidationFailed). Every other platform table
            // is refused (NotAllowed).
            const definitionTable = DEFINITION_KIND_OF_TABLE.has(table);

            assert.strictEqual(
              response.status,
              definitionTable ? 422 : 403,
              `POST ${table}`
            );
            assert.strictEqual(
              codeOf(response),
              definitionTable ? "ValidationFailed" : "NotAllowed"
            );
          }

          // Tables no definition describes are no table at all to them.
          for (const table of yield* internalTables(snapshot)) {
            const response = yield* http.request(
              "POST",
              `/api/v1/${collectionOf(table)}`,
              { ...caller, body: {} }
            );

            assert.strictEqual(response.status, 404, `POST ${table}`);
            assert.strictEqual(codeOf(response), "UnknownTable");
          }

          assert.deepStrictEqual(yield* changeCount(), before);
          assert.deepStrictEqual(yield* ruleText(), ruleBefore);
          assert.strictEqual(yield* deliveries(), deliveriesBefore);
        })
    );
  });
});

// ---- no-bypass-v2 ----------------------------------------------------------

/** The built-in allow-all rules (records, fields) of `core/access.yaml`. */
const ALLOW_ALL = [
  "be681045-76e4-4c0f-9220-a36ffb180413",
  "3bd8ef4a-4973-4ca2-a041-0bfd67b838e9",
] as const;

// A local allow-all pair for a role.
const allowAllFor = (roleId: string): Operation[] =>
  (["records", "fields"] as const).map((kind) => ({
    definition: {
      actions:
        kind === "records"
          ? ["read", "create", "update", "delete"]
          : ["read", "create", "update"],
      active: true,
      classId: null,
      condition: null,
      description: `copy of the admin ${kind} rule`,
      effect: "allow",
      id: freshId(),
      kind: "accessRule",
      name: null,
      owner: { layer: "local" },
      protected: false,
      roleIds: [roleId],
      target: kind === "records" ? { kind } : { fields: "*", kind },
    },
    op: "createAccessRule",
  }));

const SCHEMA_REVISION = /"schemaRevision":\d+/u;

const withoutRevision = (text: string): string =>
  text.replace(SCHEMA_REVISION, "");

/** What an admin gets on a v2 path once the allow-all rules are gone. */
interface Refusal {
  readonly status: number;
  readonly code: string;
}

const UNKNOWN_TABLE: Refusal = { code: "UnknownTable", status: 404 };

// Behind the scenes of the name scan: `no-bypass.test.ts` scans every
// source file for role-name checks. That part touches no API and runs once.
describe("no-bypass", () => {
  it("scans no source here: the role-name scan is code-level (no-bypass.test.ts)", () => {
    assert.strictEqual(ALLOW_ALL.length, 2);
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "no-bypass: without the allow-all rules admin is refused on every v2 path; another role with them is not",
      () =>
        Effect.gen(function* noBypass() {
          const http = yield* TestHttpClient;
          const catalog = yield* Catalog;
          const callers = yield* SignedInCallers;
          const { alice, carol, records } = yield* AcmeFixture;
          const { admin } = callers;

          const fresh = yield* freshAsset(alice.id, ACME.monitor, {
            name: "fresh",
          });

          const tablesOf = (caller: TestRequestOptions) =>
            http.get("/api/v1/tableMetadata", caller).pipe(Effect.map(idsOf));

          const listing = withQuery(API.asset, [
            ["fields", "name,cost"],
            ["sort", "name"],
          ]);

          // What admin reads and may open with the rules in place.
          const before = yield* http.get(listing, admin);

          const metadataBefore = yield* http.get(
            "/api/v1/tableMetadata/acmeAsset",
            admin
          );

          assert.strictEqual(before.status, 200, before.text);
          assert.strictEqual(metadataBefore.status, 200, metadataBefore.text);

          const tablesBefore = yield* tablesOf(admin);

          assert.includeMembers(tablesBefore, [
            "acmeAsset",
            "coreAccessRule",
            "coreUser",
          ]);

          // Remove the protected rules in this test database, as table
          // owner, then commit any change set so the catalog reloads.
          yield* values(
            `UPDATE core.access_rule SET active = false
              WHERE id = ANY($1::uuid[]) RETURNING id::text AS value`,
            [ALLOW_ALL]
          );
          yield* change([createRole("no_bypass_marker")]);
          yield* catalog.refresh;

          const committedBefore = yield* committedState;

          const paths: readonly (readonly [
            string,
            string,
            TestRequestOptions,
            Refusal,
          ])[] = [
            ["GET", API.asset, admin, UNKNOWN_TABLE],
            [
              "GET",
              withQuery(API.laptop, [["condition", "cost > 0"]]),
              admin,
              UNKNOWN_TABLE,
            ],
            ["GET", `${API.asset}/${records.L}`, admin, UNKNOWN_TABLE],
            ["GET", `${API.laptop}/${records.L}`, admin, UNKNOWN_TABLE],
            ["GET", `${API.asset}/${records.L}/history`, admin, UNKNOWN_TABLE],
            [
              "POST",
              API.asset,
              { ...admin, body: { name: "x" } },
              UNKNOWN_TABLE,
            ],
            [
              "PATCH",
              `${API.asset}/${fresh}`,
              merge(admin, 1, { name: "y" }),
              UNKNOWN_TABLE,
            ],
            [
              "DELETE",
              `${API.monitor}/${fresh}`,
              { ...admin, headers: { "if-match": REVISION_ONE } },
              UNKNOWN_TABLE,
            ],
            ["GET", "/api/v1/coreChange", admin, UNKNOWN_TABLE],
            ["GET", "/api/v1/coreAccessRule", admin, UNKNOWN_TABLE],
            ["GET", "/api/v1/coreRole", admin, UNKNOWN_TABLE],
            ["GET", "/api/v1/coreUserRole", admin, UNKNOWN_TABLE],
            ["GET", "/api/v1/tableMetadata/acmeAsset", admin, UNKNOWN_TABLE],
            [
              "GET",
              "/api/v1/tableMetadata/acmeLaptop/schema.json",
              admin,
              UNKNOWN_TABLE,
            ],
            [
              "GET",
              "/api/v1/tableMetadata/coreAccessRule",
              admin,
              UNKNOWN_TABLE,
            ],
            // `coreUser` stays known through the `authenticated` rule, which
            // only reads; the built-in deny refuses deletes, and no rule
            // lets admin write.
            [
              "PATCH",
              `${USER_COLLECTION}/${carol.id}`,
              merge(admin, 1, { name: "z" }),
              { code: "NotAllowed", status: 403 },
            ],
            [
              "DELETE",
              `${USER_COLLECTION}/${carol.id}`,
              { ...admin, headers: { "if-match": REVISION_ONE } },
              { code: "NotAllowed", status: 403 },
            ],
          ];

          for (const [method, path, options, expected] of paths) {
            const response = yield* http.request(method, path, options);

            assert.deepStrictEqual(
              { code: codeOf(response), status: response.status },
              expected,
              `${method} ${path}`
            );
          }

          assert.deepStrictEqual(yield* committedState, committedBefore);

          // Only `coreUser`, through the `authenticated` rule, is left.
          assert.deepStrictEqual(yield* tablesOf(admin), ["coreUser"]);

          // Every table of the `core` schema but the user table, from
          // pg_class: tables a later migration adds are covered too.
          const coreTables = (yield* coreSchemaTables()).filter(
            (table) => table !== "core.user"
          );

          for (const table of coreTables) {
            const collection = collectionOf(table);

            for (const path of [
              `/api/v1/${collection}`,
              `/api/v1/tableMetadata/${collection}`,
            ]) {
              const response = yield* http.get(path, admin);

              assert.deepStrictEqual(
                { code: codeOf(response), status: response.status },
                UNKNOWN_TABLE,
                path
              );
            }
          }

          // Admin still holds the admin role; it grants nothing by name.
          const me = yield* http.get("/api/v1/session/current", admin);

          assert.strictEqual(me.status, 200, me.text);
          assert.include(me.text, "admin");

          // A role named otherwise, with copies of the rules, is admin.
          const deputy = createRole("deputy");

          const deputyId =
            deputy.op === "createRole" ? deputy.definition.id : "";

          yield* change([deputy]);
          yield* change(allowAllFor(deputyId));

          // Eve holds only `deputy` (and `authenticated`, as Ada does).
          yield* createFixtureUser(yield* catalog.refresh, {
            active: true,
            login: "eve",
            name: "Eve",
            password: "eve-password",
            roles: ["deputy"],
          });

          const eve = { token: yield* http.signIn("eve", "eve-password") };
          const asDeputy = yield* http.get(listing, eve);

          assert.strictEqual(asDeputy.status, 200, asDeputy.text);
          assert.strictEqual(asDeputy.text, before.text);

          const deputyMetadata = yield* http.get(
            "/api/v1/tableMetadata/acmeAsset",
            eve
          );

          assert.strictEqual(
            withoutRevision(deputyMetadata.text),
            withoutRevision(metadataBefore.text)
          );

          // Platform tables match only core rules: the copies are local, so
          // they stop there. The rule's owner layer decides, not a name.
          const eveTables = yield* tablesOf(eve);

          assert.includeMembers(eveTables, ["acmeAsset", "coreUser"]);
          assert.notIncludeMembers(eveTables, ["coreChange", "coreAccessRule"]);

          const changes = yield* http.get("/api/v1/coreChange", eve);

          assert.deepStrictEqual(
            { code: codeOf(changes), status: changes.status },
            UNKNOWN_TABLE
          );
        })
    );
  });
});

// ---- invisible-identity-v2 -------------------------------------------------

/** One v2 request shape, applied to a record ID. */
interface Probe {
  readonly name: string;
  readonly method: string;
  readonly path: (id: string) => string;
  readonly options: TestRequestOptions;
}

const historyPath = (collection: string, query: string) => (id: string) =>
  `${collection}/${id}/history?${query}`;

const probes = (caller: TestRequestOptions): readonly Probe[] => [
  {
    method: "GET",
    name: "GET with an unknown field",
    options: caller,
    path: (id) => `${API.laptop}/${id}?fields=nosuchfield`,
  },
  {
    method: "GET",
    name: "GET with a bad fields selection",
    options: caller,
    path: (id) => `${API.asset}/${id}?fields=!`,
  },
  {
    method: "GET",
    name: "history with an unknown field filter",
    options: caller,
    path: historyPath(API.laptop, "field=nosuchfield"),
  },
  {
    method: "GET",
    name: "history with a bad date",
    options: caller,
    path: historyPath(API.asset, "since=yesterday"),
  },
  {
    method: "GET",
    name: "history with a bad kind and actor",
    options: caller,
    path: historyPath(API.asset, "kind=rename&actor=nobody"),
  },
  {
    method: "PATCH",
    name: "PATCH with an unknown field",
    options: merge(caller, 1, { nosuchfield: 1 }),
    path: (id) => `${API.laptop}/${id}`,
  },
  {
    method: "PATCH",
    name: "PATCH naming @type",
    options: merge(caller, 1, { "@type": "x" }),
    path: (id) => `${API.asset}/${id}`,
  },
  {
    method: "PATCH",
    name: "PATCH with an invalid value and a stale revision",
    options: merge(caller, 99, { cost: 12.5, name: null }),
    path: (id) => `${API.asset}/${id}`,
  },
  {
    method: "PATCH",
    name: "PATCH with a body that is not JSON",
    options: {
      ...caller,
      headers: {
        "content-type": "application/merge-patch+json",
        "if-match": REVISION_ONE,
      },
      rawBody: "{nope",
    },
    path: (id) => `${API.laptop}/${id}`,
  },
  {
    method: "PATCH",
    name: "PATCH with a malformed If-Match",
    options: {
      ...caller,
      headers: {
        "content-type": "application/merge-patch+json",
        "if-match": "1",
      },
      rawBody: JSON.stringify({ name: "x" }),
    },
    path: (id) => `${API.laptop}/${id}`,
  },
  {
    method: "DELETE",
    name: "DELETE with a stale revision",
    options: { ...caller, headers: { "if-match": '"99"' } },
    path: (id) => `${API.asset}/${id}`,
  },
  {
    method: "DELETE",
    name: "DELETE without If-Match",
    options: caller,
    path: (id) => `${API.laptop}/${id}`,
  },
];

describe("invisible-identity", () => {
  it("covers every by-ID route", () => {
    const methods = new Set(probes({}).map((probe) => probe.method));

    assert.deepStrictEqual([...methods].toSorted(), ["DELETE", "GET", "PATCH"]);
  });

  layer(callersTestLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "invisible-identity: an invisible record and an unknown ID give byte-identical v2 responses",
      () =>
        Effect.gen(function* identical() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          for (const probe of probes(callers.bob)) {
            const hidden = yield* http.request(
              probe.method,
              probe.path(records.K),
              probe.options
            );

            const missing = yield* http.request(
              probe.method,
              probe.path(RANDOM_ID),
              probe.options
            );

            assert.strictEqual(hidden.status, missing.status, probe.name);
            assert.strictEqual(hidden.text, missing.text, probe.name);
          }
        })
    );

    dbTest.effect(
      "invisible-identity: on a visible record the same parameters give their own errors",
      () =>
        Effect.gen(function* visible() {
          const http = yield* TestHttpClient;
          const callers = yield* SignedInCallers;
          const { records } = yield* AcmeFixture;

          const unknownField = yield* http.get(
            historyPath(API.laptop, "field=nosuchfield")(records.L),
            callers.bob
          );

          assert.strictEqual(unknownField.status, 400);
          assert.strictEqual(codeOf(unknownField), "UnknownField");

          const badDate = yield* http.get(
            historyPath(API.asset, "since=yesterday")(records.L),
            callers.bob
          );

          assert.strictEqual(badDate.status, 400);
          assert.strictEqual(codeOf(badDate), "InvalidRequest");
        })
    );
  });
});
