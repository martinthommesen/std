/**
 * The two-user read tests of Contracts 3 "Acceptance tests" through the
 * child endpoints `/acme.laptop` and `/acme.monitor` (the Stage 0 gate:
 * filtering, sorting and reference labels "through both parent and child
 * endpoints"; Contracts 3.3 to 3.6). `read-authorization.test.ts` and
 * `cursor-nulls.test.ts` cover the same cases through `/acme.asset`.
 *
 * A laptop has its own rules (8 and 9), so `/acme.laptop` compiles its
 * own visibility and masks: rule 6 (`purchased_on` of lost assets) and
 * rule 10 (`docked_to` of assets costing over 2000) reach it from the
 * parent. Hidden values must behave exactly like empty in filters, sorts
 * and cursors, and rule inputs Bob cannot read must change nothing but the
 * rule's own outcome.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { RecordJson } from "@std/api/records";
import { stringifyJson } from "@std/values/json";
import { isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ACME, AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import type { OwnerRecord } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  allPages,
  listOf,
  listPath,
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";
import { create, patch, versionOf } from "./writes-support.ts";

const ASSET = "acme.asset";
const LAPTOP = "acme.laptop";
const MONITOR = "acme.monitor";

/**
 * The IDs of one page of a list, in order.
 * @param token - The session token.
 * @param table - The endpoint.
 * @param query - Parameters.
 * @returns The IDs.
 */
const idsOf = Effect.fn("ChildEndpointReads.idsOf")(function* idsOf(
  token: string,
  table: string,
  query: Readonly<Record<string, string>>
) {
  const http = yield* TestHttpClient;

  const page = yield* listOf(
    yield* http.get(listPath(table, { sort: "name", ...query }), { token })
  );

  return page.records.map((record) => record.id);
});

/**
 * Inserts records of one class as table owner, in a request transaction.
 * @param classId - The concrete class.
 * @param records - The records.
 * @returns Their IDs.
 */
const insert = Effect.fn("ChildEndpointReads.insert")(function* insert(
  classId: string,
  records: readonly OwnerRecord[]
) {
  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  return yield* request(
    Effect.gen(function* insertRecords() {
      return yield* insertAsOwner(yield* catalog.current, classId, records);
    })
  );
});

/**
 * The body texts of GET requests, in order.
 * @param token - The session token.
 * @param paths - The paths.
 * @returns The texts.
 */
const textsOf = Effect.fn("ChildEndpointReads.textsOf")(function* textsOf(
  token: string,
  paths: readonly string[]
) {
  const http = yield* TestHttpClient;
  const texts: string[] = [];

  for (const path of paths) {
    texts.push((yield* http.get(path, { token })).text);
  }

  return texts;
});

/**
 * A record read with labels.
 * @param token - The session token.
 * @param table - The endpoint.
 * @param id - The record.
 * @returns The record.
 */
const labelled = Effect.fn("ChildEndpointReads.labelled")(function* labelled(
  token: string,
  table: string,
  id: string
) {
  const http = yield* TestHttpClient;

  return yield* recordOf(
    yield* http.get(recordPath(table, id, { labels: "true" }), { token })
  );
});

/**
 * Sets columns of `acme.asset` rows directly, as table owner.
 * @param assignments - The `SET` list over parameters from `$2`.
 * @param id - The record.
 * @param parameters - The parameters from `$2`.
 * @returns The effect.
 */
const setAsset = (
  assignments: string,
  id: string,
  parameters: readonly string[] = []
) =>
  values(
    `UPDATE acme.asset SET ${assignments} WHERE id = $1::uuid RETURNING id::text AS value`,
    [id, ...parameters]
  );

/**
 * Two more records of Bob's per child class: an in-use one and a lost one
 * (whose `purchased_on` Bob cannot read), both bought on 2025-05-01.
 * @returns The lost IDs by endpoint.
 */
const insertLostChildren = Effect.gen(function* insertLostChildren() {
  const { bob } = yield* AcmeFixture;

  const common = {
    owner: bob.id,
    purchased_on: "2025-05-01",
    status: "lost",
  };

  const [lostLaptop] = yield* insert(ACME.laptop, [
    {
      by: bob.id,
      values: { ...common, cost: "900", name: "LL", serial: "SN-LL" },
    },
  ]);

  const [lostMonitor] = yield* insert(ACME.monitor, [
    {
      by: bob.id,
      values: { ...common, cost: "100", name: "ML", size_inches: "22" },
    },
  ]);

  return { [LAPTOP]: lostLaptop ?? "", [MONITOR]: lostMonitor ?? "" };
});

describe("masked-filter", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop and /acme.monitor a hidden purchased_on behaves exactly like empty",
      () =>
        Effect.gen(function* maskedFilterChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");
          const lost = yield* insertLostChildren;
          const inUse = { [LAPTOP]: records.L, [MONITOR]: records.M };

          const filters = [
            'purchased_on > "2000-01-01"',
            'not (purchased_on > "2000-01-01")',
            "purchased_on is empty",
            "purchased_on is not empty",
            'purchased_on = "2025-05-01"',
            'purchased_on in ("2025-05-01", "2024-06-01", "2025-01-15")',
          ];

          for (const table of [LAPTOP, MONITOR] as const) {
            const bobIds = (filter: string) => idsOf(bob, table, { filter });

            // Bob: the lost record's date is empty to him.
            assert.deepStrictEqual(
              yield* bobIds('purchased_on > "2000-01-01"'),
              [inUse[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds('not (purchased_on > "2000-01-01")'),
              [lost[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds("purchased_on is empty"),
              [lost[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds('purchased_on = "2025-05-01"'),
              [],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds(
                'purchased_on in ("2025-05-01", "2024-06-01", "2025-01-15")'
              ),
              [inUse[table]],
              table
            );

            // Alice reads every date.
            assert.include(
              yield* idsOf(alice, table, {
                filter: 'purchased_on = "2025-05-01"',
              }),
              lost[table],
              table
            );
            assert.notInclude(
              yield* idsOf(alice, table, { filter: "purchased_on is empty" }),
              lost[table],
              table
            );

            // The child endpoint agrees with the parent endpoint.
            const parent = yield* idsOf(bob, ASSET, {
              filter: "purchased_on is empty",
            });

            assert.include(parent, lost[table], table);
          }

          // Whatever the hidden dates are, Bob's responses are byte-identical.
          const responses = Effect.gen(function* bobResponses() {
            const texts: string[] = [];

            for (const table of [LAPTOP, MONITOR]) {
              for (const filter of filters) {
                const response = yield* http.get(
                  listPath(table, { filter, sort: "name" }),
                  { token: bob }
                );

                texts.push(response.text);
              }
            }

            return texts;
          });

          const before = yield* responses;

          for (const id of Object.values(lost)) {
            yield* setAsset("purchased_on = '1999-01-01'", id);
          }

          assert.deepStrictEqual(yield* responses, before);

          for (const id of Object.values(lost)) {
            yield* setAsset("purchased_on = '2025-01-15'", id);
          }

          assert.deepStrictEqual(yield* responses, before);
        })
    );
  });
});

describe("hidden-names", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop and /acme.monitor a never-readable name and a misspelled one get the same response",
      () =>
        Effect.gen(function* hiddenNamesChild() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");

          // [table, parameter, hidden value, the same with nosuchfield]
          const cases = [
            ...[LAPTOP, MONITOR].flatMap((table) => [
              [table, "filter", "cost > 0", "nosuchfield > 0"],
              [table, "sort", "cost", "nosuchfield"],
              [table, "sort", "-cost", "-nosuchfield"],
              [table, "fields", "name,cost", "name,nosuchfield"],
              [
                table,
                "filter",
                "docked_to.cost > 0",
                "docked_to.nosuchfield > 0",
              ],
              [
                table,
                "fields",
                "name,docked_to.cost",
                "name,docked_to.nosuchfield",
              ],
            ]),
            // disk_key is a laptop field Bob can never read.
            [LAPTOP, "filter", 'disk_key = "x"', 'nosuchfield = "x"'],
            [LAPTOP, "sort", "disk_key", "nosuchfield"],
            [LAPTOP, "fields", "disk_key", "nosuchfield"],
            [LAPTOP, "sort", "serial,disk_key", "serial,nosuchfield"],
          ] as const;

          for (const [table, parameter, hidden, missing] of cases) {
            const left = yield* http.get(
              listPath(table, { [parameter]: hidden }),
              { token }
            );

            const right = yield* http.get(
              listPath(table, { [parameter]: missing }),
              { token }
            );

            const name = hidden.includes("disk_key") ? "disk_key" : "cost";

            assert.strictEqual(left.status, 400, `${table} ${hidden}`);
            assert.strictEqual(
              yield* tagOf(left),
              "UnknownField",
              `${table} ${hidden}`
            );
            assert.strictEqual(
              left.text.replace(name, "NAME"),
              right.text.replace("nosuchfield", "NAME"),
              `${table} ${hidden}`
            );
          }

          // A readable child field is known: rule 8 lets Bob read serial.
          const serial = yield* http.get(
            listPath(LAPTOP, { filter: 'serial = "SN-L"', sort: "serial" }),
            { token }
          );

          assert.strictEqual(serial.status, 200);
        })
    );
  });
});

describe("hidden-rule-input", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop rule 10 reads cost: only whether docked_to is withheld changes, in filters and sorts too",
      () =>
        Effect.gen(function* hiddenRuleInputChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");

          const requests = [
            recordPath(LAPTOP, records.L, { labels: "true" }),
            listPath(LAPTOP, { filter: "docked_to is empty" }),
            listPath(LAPTOP, { filter: `docked_to = "${records.AM}"` }),
            listPath(LAPTOP, { filter: "docked_to.name is empty" }),
            listPath(LAPTOP, { labels: "true", sort: "docked_to" }),
            listPath(LAPTOP, { fields: "name,docked_to.name" }),
          ];

          const texts = textsOf(bob, requests);

          const setCost = (cost: string) =>
            setAsset("cost = $2::numeric", records.L, [cost]);

          // Cost 1200: docked_to is readable.
          const cheap = yield* recordOf(
            yield* http.get(requests[0] ?? "", { token: bob })
          );

          assert.strictEqual(cheap.values.docked_to, records.AM);
          assert.notInclude(cheap.withheld ?? [], "docked_to");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { filter: "docked_to is empty" }),
            []
          );
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, {
              filter: `docked_to = "${records.AM}"`,
            }),
            [records.L]
          );

          const readable = yield* texts;

          // Over 2000: withheld, and it filters like empty.
          yield* setCost("2500");

          const withheld = yield* recordOf(
            yield* http.get(requests[0] ?? "", { token: bob })
          );

          assert.include(withheld.withheld ?? [], "docked_to");
          assert.notProperty(withheld.values, "docked_to");
          assert.notProperty(withheld.labels ?? {}, "docked_to");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { filter: "docked_to is empty" }),
            [records.L]
          );
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, {
              filter: `docked_to = "${records.AM}"`,
            }),
            []
          );

          const hidden = yield* texts;

          // Any other cost over 2000 changes nothing Bob sees.
          for (const cost of ["2000.01", "9999.99", "1000000"]) {
            yield* setCost(cost);
            assert.deepStrictEqual(yield* texts, hidden, cost);
          }

          // Back under 2000, Bob sees what he saw before.
          yield* setCost("1500");
          assert.deepStrictEqual(yield* texts, readable);
        })
    );
  });
});

describe("references", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop and /acme.monitor a hidden target gives the bare UUID without a label",
      () =>
        Effect.gen(function* labelsChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");
          const labels = { labels: "true" };

          const asBob = yield* labelled(bob, LAPTOP, records.L);
          const asAlice = yield* labelled(alice, LAPTOP, records.L);

          assert.strictEqual(asBob.values.docked_to, records.AM);
          assert.notProperty(asBob.labels ?? {}, "docked_to");
          assert.strictEqual(asBob.labels?.owner, "Bob");
          assert.strictEqual(asBob.labels?.created_by, "Bob");
          assert.strictEqual(asAlice.labels?.docked_to, "Alice monitor");
          assert.strictEqual(asAlice.labels?.owner, "Bob");

          // Lists label the same way as single reads.
          const bobList = yield* listOf(
            yield* http.get(listPath(LAPTOP, labels), { token: bob })
          );

          assert.deepStrictEqual(
            bobList.records.map((record) => ({
              id: record.id,
              labels: record.labels,
            })),
            [{ id: records.L, labels: asBob.labels }]
          );

          // Through the monitor endpoint: Bob's M, and Alice's AM is a 404.
          const monitor = yield* labelled(bob, MONITOR, records.M);

          assert.strictEqual(monitor.labels?.owner, "Bob");
          assert.strictEqual(monitor.values.docked_to, null);
          assert.notProperty(monitor.labels ?? {}, "docked_to");

          const hiddenMonitor = yield* http.get(
            recordPath(MONITOR, records.AM, labels),
            { token: bob }
          );

          assert.strictEqual(hiddenMonitor.status, 404);
        })
    );

    dbTest.effect(
      "through /acme.laptop a filter or a path through a hidden target matches nothing",
      () =>
        Effect.gen(function* pathsChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");

          const filter = (token: string, text: string) =>
            idsOf(token, LAPTOP, { filter: text });

          assert.deepStrictEqual(
            yield* filter(bob, 'docked_to.name = "Alice monitor"'),
            []
          );
          assert.deepStrictEqual(
            yield* filter(alice, 'docked_to.name = "Alice monitor"'),
            [records.L]
          );
          // A hidden target behaves like an empty reference.
          assert.deepStrictEqual(
            yield* filter(bob, "docked_to.name is empty"),
            [records.L]
          );
          assert.deepStrictEqual(
            yield* filter(alice, "docked_to.name is empty"),
            [records.K]
          );
          assert.deepStrictEqual(yield* filter(bob, 'owner.name = "Bob"'), [
            records.L,
          ]);
          assert.deepStrictEqual(yield* filter(alice, 'owner.name = "Bob"'), [
            records.L,
          ]);

          const fields = "name,docked_to.name,owner.name";

          const bobPaths = yield* recordOf(
            yield* http.get(recordPath(LAPTOP, records.L, { fields }), {
              token: bob,
            })
          );

          const alicePaths = yield* recordOf(
            yield* http.get(recordPath(LAPTOP, records.L, { fields }), {
              token: alice,
            })
          );

          assert.strictEqual(bobPaths.values["docked_to.name"], null);
          assert.strictEqual(bobPaths.values["owner.name"], "Bob");
          assert.strictEqual(
            alicePaths.values["docked_to.name"],
            "Alice monitor"
          );

          // A withheld reference (rule 10) leaves out its path's key too.
          yield* setAsset("cost = 2500", records.L);

          const withheld = yield* recordOf(
            yield* http.get(
              recordPath(LAPTOP, records.L, { fields, labels: "true" }),
              { token: bob }
            )
          );

          assert.notProperty(withheld.values, "docked_to.name");
          assert.notProperty(withheld.labels ?? {}, "docked_to");
          assert.include(withheld.withheld ?? [], "docked_to.name");
          assert.strictEqual(withheld.values["owner.name"], "Bob");
        })
    );

    dbTest.effect(
      "through /acme.laptop a visible target is labelled, and writing a hidden one is InvalidReference",
      () =>
        Effect.gen(function* guardChild() {
          const http = yield* TestHttpClient;
          const { bob: bobUser, records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");

          // L's fixture cost, under rule 10's limit (another test raises it).
          yield* setAsset("cost = 1200", records.L);

          const version = (yield* versionOf(records.L)) ?? 0;

          // Bob docks L to his own monitor M: a visible target.
          const docked = yield* patch(bob, LAPTOP, records.L, version, {
            docked_to: records.M,
          });

          assert.strictEqual(docked.status, 200);

          const dockedToM = yield* labelled(bob, LAPTOP, records.L);

          assert.strictEqual(dockedToM.values.docked_to, records.M);
          assert.strictEqual(dockedToM.labels?.docked_to, "M");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { filter: 'docked_to.name = "M"' }),
            [records.L]
          );

          // Hidden targets (Alice's monitor and laptop) are refused exactly
          // like an unknown ID, on update and on create.
          const current = (yield* versionOf(records.L)) ?? 0;

          const random = yield* patch(bob, LAPTOP, records.L, current, {
            docked_to: randomUUID(),
          });

          assert.strictEqual(random.status, 422);
          assert.strictEqual(yield* tagOf(random), "InvalidReference");

          for (const target of [records.AM, records.K]) {
            const hidden = yield* patch(bob, LAPTOP, records.L, current, {
              docked_to: target,
            });

            assert.strictEqual(hidden.text, random.text);
          }

          assert.strictEqual(yield* versionOf(records.L), current);

          const body = (target: string): JsonValue => ({
            docked_to: target,
            name: "dock",
            owner: bobUser.id,
            purchased_on: "2026-01-01",
            serial: "SN-DOCK",
          });

          const createdRandom = yield* create(bob, LAPTOP, body(randomUUID()));

          assert.strictEqual(yield* tagOf(createdRandom), "InvalidReference");

          for (const target of [records.AM, records.K]) {
            const created = yield* create(bob, LAPTOP, body(target));

            assert.strictEqual(created.text, createdRandom.text);
          }

          const createdMonitor = yield* create(bob, MONITOR, {
            docked_to: records.AM,
            name: "dock",
            owner: bobUser.id,
          });

          const createdMonitorRandom = yield* create(bob, MONITOR, {
            docked_to: randomUUID(),
            name: "dock",
            owner: bobUser.id,
          });

          assert.strictEqual(yield* tagOf(createdMonitor), "InvalidReference");
          assert.strictEqual(createdMonitor.text, createdMonitorRandom.text);
        })
    );
  });
});

// Sorting and keyset cursors through /acme.laptop (Contracts 3.5).

const BOB_LAPTOPS = 150;
const ALICE_LAPTOPS = 60;
const PAGE = "7";
const MULTIPLIER = 1_103_515_245;
const INCREMENT = 12_345;
const MODULUS = 2 ** 31;
const DAYS = 9;
const SERIALS = 40;
const MAX_COST = 3000;
const LOST_SHARE = 0.5;
const DOCKED_SHARE = 0.6;

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

const pick = (random: () => number, count: number): number =>
  Math.floor(random() * count);

/**
 * Bulk laptops of one owner: about half lost (their `purchased_on` hidden
 * from Bob), costs up to 3000 (over 2000, rule 10 hides `docked_to` from
 * Bob), many equal dates and serials, some docked to a monitor.
 * @param prefix - Starts each name, after `bulk-`.
 * @param owner - The owner.
 * @param targets - Monitors to dock to.
 * @param random - The number source.
 * @param count - How many.
 * @returns The records.
 */
const bulkLaptops = (
  prefix: string,
  owner: string,
  targets: readonly string[],
  random: () => number,
  count: number
): OwnerRecord[] =>
  Array.from({ length: count }, (_, index) => ({
    by: owner,
    values: {
      cost: String(pick(random, MAX_COST)),
      docked_to:
        random() < DOCKED_SHARE
          ? (targets[pick(random, targets.length)] ?? null)
          : null,
      name: `bulk-${prefix}-${String(index).padStart(4, "0")}`,
      owner,
      purchased_on: `2024-02-${String(1 + pick(random, DAYS)).padStart(2, "0")}`,
      serial: `SN-${String(pick(random, SERIALS)).padStart(3, "0")}`,
      status: random() < LOST_SHARE ? "lost" : "in_use",
    },
  }));

/** The sorts: masked fields, a child-level field, parent-level fields. */
const SORTS = [
  "purchased_on",
  "-purchased_on",
  "docked_to",
  "-docked_to",
  "serial",
  "-serial",
  "serial,-purchased_on",
  "-serial,docked_to",
  "name",
  "-status,purchased_on,name",
  "status,-docked_to",
];

/**
 * A record's sort key as the caller sees it: absent or withheld is empty.
 * @param record - The record.
 * @param name - The field.
 * @returns The key text, or null for empty.
 */
const keyOf = (record: RecordJson, name: string): string | null => {
  const value: JsonValue | undefined = record.values[name];

  if (
    value === undefined ||
    value === null ||
    (record.withheld ?? []).includes(name)
  ) {
    return null;
  }

  // Text keys compare by casefold; these keys are ASCII.
  return isJsonString(value) ? value.toLowerCase() : stringifyJson(value);
};

/**
 * Compares two texts by UTF-16 code units, which is code point order for
 * the ASCII keys here and for lowercase UUIDs.
 * @param left - A text.
 * @param right - Another.
 * @returns Negative, zero or positive.
 */
const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

/**
 * The order Contracts 3.5 fixes, computed from what the caller can read:
 * ascending `NULLS LAST`, descending `NULLS FIRST`, ties by `id` ascending.
 * @param records - The records.
 * @param sort - The sort parameter.
 * @returns The IDs in order.
 */
const expectedOrder = (
  records: readonly RecordJson[],
  sort: string
): string[] => {
  const keys = sort.split(",").map((part) => ({
    descending: part.startsWith("-"),
    name: part.replace(/^-/u, ""),
  }));

  const compare = (left: RecordJson, right: RecordJson): number => {
    for (const { descending, name } of keys) {
      const a = keyOf(left, name);
      const b = keyOf(right, name);

      if (a !== b) {
        if (a === null) {
          return descending ? -1 : 1;
        }

        if (b === null) {
          return descending ? 1 : -1;
        }

        return descending ? compareText(b, a) : compareText(a, b);
      }
    }

    return compareText(left.id, right.id);
  };

  return records.toSorted(compare).map((record) => record.id);
};

/** The filter selecting the bulk laptops. */
const BULK = 'name starts with "bulk-"';

/**
 * How many records withhold a field.
 * @param records - The records.
 * @param name - The field.
 * @returns The count.
 */
const withheldCount = (records: readonly RecordJson[], name: string): number =>
  records.filter((record) => (record.withheld ?? []).includes(name)).length;

/**
 * One sort of the bulk laptops through `/acme.laptop`: asserts that pages
 * of 7 return every row once, in the order of one unpaged query, which is
 * the order Contracts 3.5 fixes over what the caller can read.
 * @param token - The session token.
 * @param sort - The sort parameter.
 * @param rows - How many bulk laptops the caller sees.
 * @returns The text of every page.
 */
const sortedPages = Effect.fn("ChildEndpointReads.sortedPages")(
  function* sortedPages(token: string, sort: string, rows: number) {
    const http = yield* TestHttpClient;

    const unpaged = yield* listOf(
      yield* http.get(
        listPath(LAPTOP, { count: "true", filter: BULK, limit: "1000", sort }),
        { token }
      )
    );

    const paged = yield* allPages(token, LAPTOP, {
      filter: BULK,
      limit: PAGE,
      sort,
    });

    const expected = unpaged.records.map((record) => record.id);
    const actual = paged.records.map((record) => record.id);

    assert.strictEqual(expected.length, rows, sort);
    assert.strictEqual(unpaged.count, rows, sort);
    assert.strictEqual(new Set(actual).size, actual.length, sort);
    assert.deepStrictEqual(actual, expected, sort);
    assert.deepStrictEqual(
      expected,
      expectedOrder(unpaged.records, sort),
      sort
    );

    return paged.texts;
  }
);

describe("cursor-nulls", () => {
  it("orders empty keys last ascending and first descending, ties by id", () => {
    const record = (id: string, serial: string | null): RecordJson => ({
      class: LAPTOP,
      id,
      values: { serial },
      version: 1,
    });

    const withheld: RecordJson = {
      class: LAPTOP,
      id: "00000000-0000-7000-8000-000000000001",
      values: {},
      version: 1,
      withheld: ["serial"],
    };

    const records = [
      record("00000000-0000-7000-8000-000000000004", "SN-B"),
      record("00000000-0000-7000-8000-000000000003", null),
      withheld,
      record("00000000-0000-7000-8000-000000000002", "sn-a"),
      record("00000000-0000-7000-8000-000000000005", "sn-b"),
    ];

    assert.deepStrictEqual(expectedOrder(records, "serial"), [
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000004",
      "00000000-0000-7000-8000-000000000005",
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000003",
    ]);
    assert.deepStrictEqual(expectedOrder(records, "-serial"), [
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000003",
      "00000000-0000-7000-8000-000000000004",
      "00000000-0000-7000-8000-000000000005",
      "00000000-0000-7000-8000-000000000002",
    ]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop keyset pages over masked, child and parent keys return every row once, in order",
      () =>
        Effect.gen(function* sortsChild() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const random = sequence(11);
          const { AM, M } = fixture.records;

          yield* insert(ACME.laptop, [
            ...bulkLaptops("b", fixture.bob.id, [AM, M], random, BOB_LAPTOPS),
            ...bulkLaptops(
              "a",
              fixture.alice.id,
              [AM, M],
              random,
              ALICE_LAPTOPS
            ),
          ]);

          const tokens = {
            alice: yield* http.signIn("alice", "alice-password"),
            bob: yield* http.signIn("bob", "bob-password"),
          };

          const filter = BULK;
          const rows = { alice: BOB_LAPTOPS + ALICE_LAPTOPS, bob: BOB_LAPTOPS };

          const sortAll = Effect.fn("ChildEndpointReads.sortAll")(
            function* sortAll(who: "alice" | "bob") {
              const texts: string[][] = [];

              for (const sort of SORTS) {
                texts.push(yield* sortedPages(tokens[who], sort, rows[who]));
              }

              return texts;
            }
          );

          yield* sortAll("alice");

          const bobBefore = yield* sortAll("bob");

          // Bob's masked keys: some hidden dates and docked_to values exist.
          const bobRecords = yield* listOf(
            yield* http.get(listPath(LAPTOP, { filter, limit: "1000" }), {
              token: tokens.bob,
            })
          );

          assert.isAbove(withheldCount(bobRecords.records, "purchased_on"), 0);
          assert.isAbove(withheldCount(bobRecords.records, "docked_to"), 0);

          // Changing only values Bob cannot read, without changing any rule
          // outcome, changes no byte of any page: not the order, not the
          // cursors.
          yield* values(
            `UPDATE acme.asset SET purchased_on = purchased_on - 400
             WHERE status = 'lost' AND name LIKE 'bulk-%' RETURNING id::text AS value`
          );
          yield* values(
            `UPDATE acme.asset
             SET cost = cost + 500,
                 docked_to = CASE WHEN docked_to IS NULL THEN $1::uuid ELSE NULL END
             WHERE cost > 2000 AND name LIKE 'bulk-%' RETURNING id::text AS value`,
            [AM]
          );

          assert.deepStrictEqual(yield* sortAll("bob"), bobBefore);
        }),
      { timeout: 240_000 }
    );

    dbTest.effect(
      "through /acme.laptop a cursor from one sort is refused for another",
      () =>
        Effect.gen(function* cursorSignature() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("alice", "alice-password");

          const first = yield* listOf(
            yield* http.get(listPath(LAPTOP, { limit: "1", sort: "serial" }), {
              token,
            })
          );

          const cursor = first.nextCursor ?? "";

          const other = yield* http.get(
            listPath(LAPTOP, { cursor, limit: "1", sort: "-serial" }),
            { token }
          );

          const parent = yield* http.get(
            listPath(ASSET, { cursor, limit: "1", sort: "serial" }),
            { token }
          );

          assert.notStrictEqual(cursor, "");
          assert.strictEqual(other.status, 400);
          assert.strictEqual(yield* tagOf(other), "InvalidCursor");
          // serial is unknown at the parent, before the cursor is read.
          assert.strictEqual(yield* tagOf(parent), "UnknownField");
        })
    );
  });
});
