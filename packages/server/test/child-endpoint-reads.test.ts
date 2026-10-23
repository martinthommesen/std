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
import { stringifyJson } from "@std/values/json";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ACME, AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import type { OwnerRecord } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { arrayOf, objectOf, sequence, textOf } from "./authz-support.ts";
import {
  allPages,
  listOf,
  listPath,
  codeOf,
  readsTestLayer,
  recordPath,
  resourceOf,
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

  return page.resources.map((resource) => textOf(resource.id));
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
 * A single resource read.
 * @param token - The session token.
 * @param table - The endpoint.
 * @param id - The record.
 * @returns The resource.
 */
const read = Effect.fn("ChildEndpointReads.read")(function* read(
  token: string,
  table: string,
  id: string
) {
  const http = yield* TestHttpClient;

  return yield* resourceOf(yield* http.get(recordPath(table, id), { token }));
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

          const conditions = [
            'purchasedOn > "2000-01-01"',
            'not (purchasedOn > "2000-01-01")',
            "purchasedOn is empty",
            "purchasedOn is not empty",
            'purchasedOn = "2025-05-01"',
            'purchasedOn in ("2025-05-01", "2024-06-01", "2025-01-15")',
          ];

          for (const table of [LAPTOP, MONITOR] as const) {
            const bobIds = (condition: string) =>
              idsOf(bob, table, { condition });

            // Bob: the lost record's date is empty to him.
            assert.deepStrictEqual(
              yield* bobIds('purchasedOn > "2000-01-01"'),
              [inUse[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds('not (purchasedOn > "2000-01-01")'),
              [lost[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds("purchasedOn is empty"),
              [lost[table]],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds('purchasedOn = "2025-05-01"'),
              [],
              table
            );
            assert.deepStrictEqual(
              yield* bobIds(
                'purchasedOn in ("2025-05-01", "2024-06-01", "2025-01-15")'
              ),
              [inUse[table]],
              table
            );

            // Alice reads every date.
            assert.include(
              yield* idsOf(alice, table, {
                condition: 'purchasedOn = "2025-05-01"',
              }),
              lost[table],
              table
            );
            assert.notInclude(
              yield* idsOf(alice, table, {
                condition: "purchasedOn is empty",
              }),
              lost[table],
              table
            );

            // The child endpoint agrees with the parent endpoint.
            const parent = yield* idsOf(bob, ASSET, {
              condition: "purchasedOn is empty",
            });

            assert.include(parent, lost[table], table);
          }

          // Whatever the hidden dates are, Bob's responses are byte-identical.
          const responses = Effect.gen(function* bobResponses() {
            const texts: string[] = [];

            for (const table of [LAPTOP, MONITOR]) {
              for (const condition of conditions) {
                const response = yield* http.get(
                  listPath(table, { condition, sort: "name" }),
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
              [table, "condition", "cost > 0", "nosuchfield > 0"],
              [table, "sort", "cost", "nosuchfield"],
              [table, "sort", "-cost", "-nosuchfield"],
              [table, "fields", "name,cost", "name,nosuchfield"],
              [
                table,
                "condition",
                "dockedTo.cost > 0",
                "dockedTo.nosuchfield > 0",
              ],
              [
                table,
                "fields",
                "name,dockedTo.cost",
                "name,dockedTo.nosuchfield",
              ],
            ]),
            // diskKey is a laptop field Bob can never read.
            [LAPTOP, "condition", 'diskKey = "x"', 'nosuchfield = "x"'],
            [LAPTOP, "sort", "diskKey", "nosuchfield"],
            [LAPTOP, "fields", "diskKey", "nosuchfield"],
            [LAPTOP, "sort", "serial,diskKey", "serial,nosuchfield"],
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

            const name = hidden.includes("diskKey") ? "diskKey" : "cost";

            assert.strictEqual(left.status, 400, `${table} ${hidden}`);
            assert.strictEqual(
              yield* codeOf(left),
              "UnknownField",
              `${table} ${hidden}`
            );
            assert.strictEqual(
              left.text.replaceAll(name, "NAME"),
              right.text.replaceAll("nosuchfield", "NAME"),
              `${table} ${hidden}`
            );
          }

          // A readable child field is known: rule 8 lets Bob read serial.
          const serial = yield* http.get(
            listPath(LAPTOP, { condition: 'serial = "SN-L"', sort: "serial" }),
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
      "through /acme.laptop rule 10 reads cost: only whether dockedTo is withheld changes, in filters and sorts too",
      () =>
        Effect.gen(function* hiddenRuleInputChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");

          const requests = [
            recordPath(LAPTOP, records.L),
            listPath(LAPTOP, { condition: "dockedTo is empty" }),
            listPath(LAPTOP, { condition: `dockedTo = "${records.AM}"` }),
            listPath(LAPTOP, { condition: "dockedTo.name is empty" }),
            listPath(LAPTOP, { sort: "dockedTo" }),
            listPath(LAPTOP, { fields: "name,dockedTo.name" }),
          ];

          const texts = textsOf(bob, requests);

          const setCost = (cost: string) =>
            setAsset("cost = $2::numeric", records.L, [cost]);

          // Cost 1200: docked_to is readable.
          const cheap = yield* resourceOf(
            yield* http.get(requests[0] ?? "", { token: bob })
          );

          assert.strictEqual(objectOf(cheap.dockedTo).id, records.AM);
          assert.notInclude(arrayOf(cheap.withheld), "dockedTo");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { condition: "dockedTo is empty" }),
            []
          );
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, {
              condition: `dockedTo = "${records.AM}"`,
            }),
            [records.L]
          );

          const readable = yield* texts;

          // Over 2000: withheld, and it filters like empty.
          yield* setCost("2500");

          const withheld = yield* resourceOf(
            yield* http.get(requests[0] ?? "", { token: bob })
          );

          assert.include(arrayOf(withheld.withheld), "dockedTo");
          assert.notProperty(withheld, "dockedTo");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { condition: "dockedTo is empty" }),
            [records.L]
          );
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, {
              condition: `dockedTo = "${records.AM}"`,
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
      "through /acme.laptop and /acme.monitor a hidden target gives the bare ID without a name",
      () =>
        Effect.gen(function* labelsChild() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");

          const asBob = yield* read(bob, LAPTOP, records.L);
          const asAlice = yield* read(alice, LAPTOP, records.L);

          assert.strictEqual(objectOf(asBob.dockedTo).id, records.AM);
          assert.notProperty(objectOf(asBob.dockedTo), "name");
          assert.strictEqual(objectOf(asBob.owner).name, "Bob");
          assert.strictEqual(objectOf(asBob.createdBy).name, "Bob");
          assert.strictEqual(objectOf(asAlice.dockedTo).name, "Alice monitor");
          assert.strictEqual(objectOf(asAlice.owner).name, "Bob");

          // Lists name references the same way as single reads.
          const bobList = yield* listOf(
            yield* http.get(listPath(LAPTOP), { token: bob })
          );

          assert.deepStrictEqual(
            bobList.resources.map((resource) => ({
              createdBy: resource.createdBy,
              dockedTo: resource.dockedTo,
              id: resource.id,
              owner: resource.owner,
            })),
            [
              {
                createdBy: asBob.createdBy,
                dockedTo: asBob.dockedTo,
                id: records.L,
                owner: asBob.owner,
              },
            ]
          );

          // Through the monitor endpoint, Alice's AM is a 404 for Bob.
          const hiddenMonitor = yield* http.get(
            recordPath(MONITOR, records.AM),
            { token: bob }
          );

          assert.strictEqual(hiddenMonitor.status, 404);
        })
    );

    dbTest.effect(
      "through /acme.monitor a dockedTo whose target Bob cannot see has no name and paths through it are empty",
      () =>
        Effect.gen(function* monitorReferences() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");

          // Bob's monitor M (cost 300, so docked_to is readable to him) is
          // docked to Alice's monitor AM, which he cannot see.
          yield* setAsset("docked_to = $2::uuid", records.M, [records.AM]);

          const asBob = yield* read(bob, MONITOR, records.M);
          const asAlice = yield* read(alice, MONITOR, records.M);

          assert.strictEqual(objectOf(asBob.dockedTo).id, records.AM);
          assert.notInclude(arrayOf(asBob.withheld), "dockedTo");
          assert.notProperty(objectOf(asBob.dockedTo), "name");
          assert.strictEqual(objectOf(asBob.owner).name, "Bob");
          assert.strictEqual(objectOf(asAlice.dockedTo).id, records.AM);
          assert.strictEqual(objectOf(asAlice.dockedTo).name, "Alice monitor");

          // Lists name references the same way as single reads.
          for (const [token, expected] of [
            [bob, asBob],
            [alice, asAlice],
          ] as const) {
            const page = yield* listOf(
              yield* http.get(listPath(MONITOR, { condition: 'name = "M"' }), {
                token,
              })
            );

            assert.deepStrictEqual(
              page.resources.map((resource) => ({
                dockedTo: resource.dockedTo,
                owner: resource.owner,
              })),
              [{ dockedTo: expected.dockedTo, owner: expected.owner }]
            );
          }

          // One-hop paths in the selection.
          const fields = "name,dockedTo.name,owner.name";

          const paths = (token: string) =>
            http
              .get(recordPath(MONITOR, records.M, { fields }), { token })
              .pipe(Effect.flatMap(resourceOf));

          const bobPaths = yield* paths(bob);
          const alicePaths = yield* paths(alice);

          assert.notProperty(objectOf(bobPaths.dockedTo), "name");
          assert.strictEqual(objectOf(bobPaths.owner).name, "Bob");
          assert.strictEqual(
            objectOf(alicePaths.dockedTo).name,
            "Alice monitor"
          );
          assert.strictEqual(objectOf(alicePaths.owner).name, "Bob");

          // One-hop paths in conditions: the hidden target is an empty one.
          const condition = (token: string, text: string) =>
            idsOf(token, MONITOR, { condition: text });

          assert.deepStrictEqual(
            yield* condition(bob, 'dockedTo.name = "Alice monitor"'),
            []
          );
          assert.deepStrictEqual(
            yield* condition(alice, 'dockedTo.name = "Alice monitor"'),
            [records.M]
          );
          assert.deepStrictEqual(
            yield* condition(bob, "dockedTo.name is empty"),
            [records.M]
          );
          assert.deepStrictEqual(
            yield* condition(alice, "dockedTo.name is empty"),
            [records.AM]
          );
          // The reference itself is readable, so its value still filters.
          assert.deepStrictEqual(
            yield* condition(bob, `dockedTo = "${records.AM}"`),
            [records.M]
          );

          yield* setAsset("docked_to = NULL", records.M);
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

          const condition = (token: string, text: string) =>
            idsOf(token, LAPTOP, { condition: text });

          assert.deepStrictEqual(
            yield* condition(bob, 'dockedTo.name = "Alice monitor"'),
            []
          );
          assert.deepStrictEqual(
            yield* condition(alice, 'dockedTo.name = "Alice monitor"'),
            [records.L]
          );
          // A hidden target behaves like an empty reference.
          assert.deepStrictEqual(
            yield* condition(bob, "dockedTo.name is empty"),
            [records.L]
          );
          assert.deepStrictEqual(
            yield* condition(alice, "dockedTo.name is empty"),
            [records.K]
          );
          assert.deepStrictEqual(yield* condition(bob, 'owner.name = "Bob"'), [
            records.L,
          ]);
          assert.deepStrictEqual(
            yield* condition(alice, 'owner.name = "Bob"'),
            [records.L]
          );

          const fields = "name,dockedTo.name,owner.name";

          const bobPaths = yield* resourceOf(
            yield* http.get(recordPath(LAPTOP, records.L, { fields }), {
              token: bob,
            })
          );

          const alicePaths = yield* resourceOf(
            yield* http.get(recordPath(LAPTOP, records.L, { fields }), {
              token: alice,
            })
          );

          assert.notProperty(objectOf(bobPaths.dockedTo), "name");
          assert.strictEqual(objectOf(bobPaths.owner).name, "Bob");
          assert.strictEqual(
            objectOf(alicePaths.dockedTo).name,
            "Alice monitor"
          );

          // A withheld reference (rule 10) leaves out its path's key too.
          yield* setAsset("cost = 2500", records.L);

          const withheld = yield* resourceOf(
            yield* http.get(recordPath(LAPTOP, records.L, { fields }), {
              token: bob,
            })
          );

          assert.notProperty(withheld, "dockedTo");
          assert.include(arrayOf(withheld.withheld), "dockedTo");
          assert.strictEqual(objectOf(withheld.owner).name, "Bob");
        })
    );

    dbTest.effect(
      "through /acme.laptop a visible target is named, and writing a hidden one is InvalidReference",
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
            dockedTo: records.M,
          });

          assert.strictEqual(docked.status, 200);

          const dockedToM = yield* read(bob, LAPTOP, records.L);

          assert.strictEqual(objectOf(dockedToM.dockedTo).id, records.M);
          assert.strictEqual(objectOf(dockedToM.dockedTo).name, "M");
          assert.deepStrictEqual(
            yield* idsOf(bob, LAPTOP, { condition: 'dockedTo.name = "M"' }),
            [records.L]
          );

          // Hidden targets (Alice's monitor and laptop) are refused exactly
          // like an unknown ID, on update and on create.
          const current = (yield* versionOf(records.L)) ?? 0;

          const random = yield* patch(bob, LAPTOP, records.L, current, {
            dockedTo: randomUUID(),
          });

          assert.strictEqual(random.status, 422);
          assert.strictEqual(yield* codeOf(random), "InvalidReference");

          for (const target of [records.AM, records.K]) {
            const hidden = yield* patch(bob, LAPTOP, records.L, current, {
              dockedTo: target,
            });

            assert.strictEqual(hidden.text, random.text);
          }

          assert.strictEqual(yield* versionOf(records.L), current);

          const body = (target: string): JsonValue => ({
            dockedTo: target,
            name: "dock",
            owner: bobUser.id,
            purchasedOn: "2026-01-01",
            serial: "SN-DOCK",
          });

          const createdRandom = yield* create(bob, LAPTOP, body(randomUUID()));

          assert.strictEqual(yield* codeOf(createdRandom), "InvalidReference");

          for (const target of [records.AM, records.K]) {
            const created = yield* create(bob, LAPTOP, body(target));

            assert.strictEqual(created.text, createdRandom.text);
          }

          const createdMonitor = yield* create(bob, MONITOR, {
            dockedTo: records.AM,
            name: "dock",
            owner: bobUser.id,
          });

          const createdMonitorRandom = yield* create(bob, MONITOR, {
            dockedTo: randomUUID(),
            name: "dock",
            owner: bobUser.id,
          });

          assert.strictEqual(yield* codeOf(createdMonitor), "InvalidReference");
          assert.strictEqual(createdMonitor.text, createdMonitorRandom.text);
        })
    );
  });
});

// Sorting and keyset cursors through /acme.laptop (Contracts 3.5).

/** Bulk records per child endpoint and owner. */
const BULK_ROWS = {
  [LAPTOP]: { alice: 60, bob: 150 },
  [MONITOR]: { alice: 50, bob: 120 },
} as const;

const PAGE = "7";
const DAYS = 9;
const SERIALS = 40;
const MAX_COST = 3000;
const LOST_SHARE = 0.5;
const DOCKED_SHARE = 0.6;
const UNDATED_SHARE = 0.15;
const MIN_SIZE = 19;
const SIZES = 16;

const pick = (random: () => number, count: number): number =>
  Math.floor(random() * count);

/** A child endpoint with bulk records. */
type Child = typeof LAPTOP | typeof MONITOR;

/**
 * The child-level values of one bulk record: a laptop's serial (many
 * equal) and required date; a monitor's size (many equal) and a date that
 * is sometimes empty.
 * @param child - The endpoint.
 * @param random - The number source.
 * @returns The values.
 */
const childValues = (
  child: Child,
  random: () => number
): Record<string, string | null> => {
  const date = `2024-02-${String(1 + pick(random, DAYS)).padStart(2, "0")}`;

  return child === LAPTOP
    ? {
        purchased_on: date,
        serial: `SN-${String(pick(random, SERIALS)).padStart(3, "0")}`,
      }
    : {
        purchased_on: random() < UNDATED_SHARE ? null : date,
        size_inches: String(MIN_SIZE + pick(random, SIZES)),
      };
};

/**
 * Bulk records of one child class and owner: about half lost (their
 * `purchased_on` hidden from Bob), costs up to 3000 (over 2000, rule 10
 * hides `docked_to` from Bob), many equal keys, some docked to a target
 * Bob can see and some to one he cannot.
 * @param child - The endpoint.
 * @param prefix - Starts each name, after `bulk-`.
 * @param owner - The owner.
 * @param targets - Assets to dock to.
 * @param random - The number source.
 * @returns The records.
 */
const bulkRecords = (
  child: Child,
  prefix: string,
  owner: { readonly id: string; readonly who: "alice" | "bob" },
  targets: readonly string[],
  random: () => number
): OwnerRecord[] =>
  Array.from({ length: BULK_ROWS[child][owner.who] }, (_, index) => ({
    by: owner.id,
    values: {
      ...childValues(child, random),
      cost: String(pick(random, MAX_COST)),
      docked_to:
        random() < DOCKED_SHARE
          ? (targets[pick(random, targets.length)] ?? null)
          : null,
      name: `bulk-${prefix}-${String(index).padStart(4, "0")}`,
      owner: owner.id,
      status: random() < LOST_SHARE ? "lost" : "in_use",
    },
  }));

/** Per endpoint: masked fields, a child-level field, parent-level fields. */
const SORTS: Readonly<Record<Child, readonly string[]>> = {
  [LAPTOP]: [
    "purchasedOn",
    "-purchasedOn",
    "dockedTo",
    "-dockedTo",
    "serial",
    "-serial",
    "serial,-purchasedOn",
    "-serial,dockedTo",
    "name",
    "-status,purchasedOn,name",
    "status,-dockedTo",
  ],
  [MONITOR]: [
    "purchasedOn",
    "-purchasedOn",
    "dockedTo",
    "-dockedTo",
    "sizeInches",
    "-sizeInches",
    "sizeInches,-purchasedOn",
    "-sizeInches,dockedTo",
    "name",
    "-status,purchasedOn,name",
    "status,-dockedTo",
  ],
};

/** A non-empty sort key: a number, or a text compared by code point. */
type SortKeyValue = { readonly number: number } | { readonly text: string };

/**
 * A resource's sort key as the caller sees it: absent or withheld is empty.
 * @param record - The record.
 * @param name - The field.
 * @returns The number, the key text, or null for empty.
 */
const keyOf = (record: JsonObject, name: string): SortKeyValue | null => {
  const value: JsonValue | undefined = record[name];

  if (
    value === undefined ||
    value === null ||
    arrayOf(record.withheld).includes(name)
  ) {
    return null;
  }

  if (isJsonNumber(value)) {
    return { number: value };
  }

  // A reference sorts by the ID it holds.
  if (isJsonObject(value)) {
    return { text: textOf(value.id).toLowerCase() };
  }

  // Text keys compare by casefold; these keys are ASCII.
  return {
    text: isJsonString(value) ? value.toLowerCase() : stringifyJson(value),
  };
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
 * Compares two non-empty keys: numbers by value, texts by code point.
 * @param left - A key.
 * @param right - Another.
 * @returns Negative, zero or positive.
 */
const compareKeys = (left: SortKeyValue, right: SortKeyValue): number => {
  if ("number" in left && "number" in right) {
    return left.number - right.number;
  }

  return compareText(
    "text" in left ? left.text : String(left.number),
    "text" in right ? right.text : String(right.number)
  );
};

/**
 * Compares two keys of one sort key: empty last ascending, first
 * descending.
 * @param left - A key, or null for empty.
 * @param right - Another.
 * @param descending - The direction.
 * @returns Negative, zero or positive.
 */
const compareNullable = (
  left: SortKeyValue | null,
  right: SortKeyValue | null,
  descending: boolean
): number => {
  if (left === null || right === null) {
    if (left === right) {
      return 0;
    }

    return (left === null) === descending ? -1 : 1;
  }

  return descending ? compareKeys(right, left) : compareKeys(left, right);
};

/**
 * The order Contracts 3.5 fixes, computed from what the caller can read:
 * ascending `NULLS LAST`, descending `NULLS FIRST`, ties by `id` ascending.
 * @param records - The records.
 * @param sort - The sort parameter.
 * @returns The IDs in order.
 */
const expectedOrder = (
  records: readonly JsonObject[],
  sort: string
): string[] => {
  const keys = sort.split(",").map((part) => ({
    descending: part.startsWith("-"),
    name: part.replace(/^-/u, ""),
  }));

  const compare = (left: JsonObject, right: JsonObject): number => {
    for (const { descending, name } of keys) {
      const order = compareNullable(
        keyOf(left, name),
        keyOf(right, name),
        descending
      );

      if (order !== 0) {
        return order;
      }
    }

    return compareText(textOf(left.id), textOf(right.id));
  };

  return records.toSorted(compare).map((record) => textOf(record.id));
};

/**
 * A monitor with only a size, for the order computation's own test.
 * @param id - Its ID.
 * @param size - Its `sizeInches`.
 * @returns The resource.
 */
const sized = (id: string, size: number): JsonObject => ({
  "@type": "AcmeMonitor",
  id,
  revision: 1,
  sizeInches: size,
});

/**
 * How many bulk records of an endpoint a caller sees: Bob his own, Alice
 * every one.
 * @param table - The endpoint.
 * @param who - The caller.
 * @returns The count.
 */
const visibleBulkRows = (table: Child, who: "alice" | "bob"): number =>
  who === "bob"
    ? BULK_ROWS[table].bob
    : BULK_ROWS[table].bob + BULK_ROWS[table].alice;

/**
 * The sorts a caller can make on an endpoint: Bob cannot read a monitor's
 * own field (rule 4 grants asset fields only), so he gets no
 * `size_inches` sorts; Alice gets every one.
 * @param table - The endpoint.
 * @param who - The caller.
 * @returns The sorts.
 */
const sortsFor = (table: Child, who: "alice" | "bob"): readonly string[] =>
  who === "bob" && table === MONITOR
    ? SORTS[table].filter((sort) => !sort.includes("sizeInches"))
    : SORTS[table];

/** The condition selecting the bulk records. */
const BULK = 'name starts with "bulk-"';

/**
 * How many records withhold a field.
 * @param records - The records.
 * @param name - The field.
 * @returns The count.
 */
const withheldCount = (records: readonly JsonObject[], name: string): number =>
  records.filter((record) => arrayOf(record.withheld).includes(name)).length;

/**
 * One sort of the bulk records through a child endpoint: asserts that
 * pages of 7 return every row once, in the order of one unpaged query,
 * which is the order Contracts 3.5 fixes over what the caller can read.
 * @param table - The endpoint.
 * @param token - The session token.
 * @param sort - The sort parameter.
 * @param rows - How many bulk records the caller sees there.
 * @returns The text of every page.
 */
const sortedPages = Effect.fn("ChildEndpointReads.sortedPages")(
  function* sortedPages(
    table: Child,
    token: string,
    sort: string,
    rows: number
  ) {
    const http = yield* TestHttpClient;

    const unpaged = yield* listOf(
      yield* http.get(
        listPath(table, { condition: BULK, limit: "1000", sort }),
        { token }
      )
    );

    const paged = yield* allPages({ token }, table, {
      condition: BULK,
      limit: PAGE,
      sort,
    });

    const expected = unpaged.resources.map((resource) => textOf(resource.id));
    const actual = paged.resources.map((resource) => textOf(resource.id));
    const label = `${table} ${sort}`;

    assert.strictEqual(expected.length, rows, label);
    assert.strictEqual(unpaged.total, rows, label);
    assert.strictEqual(new Set(actual).size, actual.length, label);
    assert.deepStrictEqual(actual, expected, label);
    assert.deepStrictEqual(
      expected,
      expectedOrder(unpaged.resources, sort),
      label
    );

    return paged.texts;
  }
);

/**
 * A laptop resource; an empty attribute is absent from a resource.
 * @param id - Its ID.
 * @param serial - Its serial, or null for empty.
 * @returns The resource.
 */
const record = (id: string, serial: string | null): JsonObject =>
  serial === null
    ? { "@type": "AcmeLaptop", id, revision: 1 }
    : { "@type": "AcmeLaptop", id, revision: 1, serial };

describe("cursor-nulls", () => {
  it("orders empty keys last ascending and first descending, ties by id", () => {
    const withheld: JsonObject = {
      "@type": "AcmeLaptop",
      id: "00000000-0000-7000-8000-000000000001",
      revision: 1,
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

    assert.deepStrictEqual(
      expectedOrder(
        [
          sized("00000000-0000-7000-8000-000000000001", 24),
          sized("00000000-0000-7000-8000-000000000002", 9),
          sized("00000000-0000-7000-8000-000000000003", 100),
        ],
        "sizeInches"
      ),
      [
        "00000000-0000-7000-8000-000000000002",
        "00000000-0000-7000-8000-000000000001",
        "00000000-0000-7000-8000-000000000003",
      ]
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "through /acme.laptop and /acme.monitor keyset pages over masked, child and parent keys return every row once, in order",
      () =>
        Effect.gen(function* sortsChild() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const random = sequence(11);
          const { AM, K, L, M } = fixture.records;
          const bob = { id: fixture.bob.id, who: "bob" } as const;
          const alice = { id: fixture.alice.id, who: "alice" } as const;

          // Targets Bob can see (L, M) and cannot (AM, K).
          const targets = [AM, K, L, M];

          yield* insert(ACME.laptop, [
            ...bulkRecords(LAPTOP, "bl", bob, targets, random),
            ...bulkRecords(LAPTOP, "al", alice, targets, random),
          ]);
          yield* insert(ACME.monitor, [
            ...bulkRecords(MONITOR, "bm", bob, targets, random),
            ...bulkRecords(MONITOR, "am", alice, targets, random),
          ]);

          const tokens = {
            alice: yield* http.signIn("alice", "alice-password"),
            bob: yield* http.signIn("bob", "bob-password"),
          };

          const sortAll = Effect.fn("ChildEndpointReads.sortAll")(
            function* sortAll(who: "alice" | "bob") {
              const texts: string[][] = [];

              for (const table of [LAPTOP, MONITOR] as const) {
                for (const sort of sortsFor(table, who)) {
                  texts.push(
                    yield* sortedPages(
                      table,
                      tokens[who],
                      sort,
                      visibleBulkRows(table, who)
                    )
                  );
                }
              }

              return texts;
            }
          );

          yield* sortAll("alice");

          const bobBefore = yield* sortAll("bob");

          // A monitor's own field is never readable to Bob: its sort is
          // refused like a misspelled name.
          const bySize = yield* http.get(
            listPath(MONITOR, { condition: BULK, sort: "sizeInches" }),
            { token: tokens.bob }
          );

          assert.strictEqual(bySize.status, 400);
          assert.strictEqual(yield* codeOf(bySize), "UnknownField");

          // Bob's masked keys: some hidden dates and docked_to values exist
          // on both endpoints.
          for (const table of [LAPTOP, MONITOR] as const) {
            const bobRecords = yield* listOf(
              yield* http.get(
                listPath(table, { condition: BULK, limit: "1000" }),
                {
                  token: tokens.bob,
                }
              )
            );

            for (const name of ["purchasedOn", "dockedTo"]) {
              assert.isAbove(
                withheldCount(bobRecords.resources, name),
                0,
                `${table} ${name}`
              );
            }
          }

          // Changing only values Bob cannot read, without changing any rule
          // outcome, changes no byte of any page: not the order, not the
          // cursors.
          yield* values(
            `UPDATE acme.asset SET purchased_on = purchased_on - 400
             WHERE status = 'lost' AND purchased_on IS NOT NULL
               AND name LIKE 'bulk-%' RETURNING id::text AS value`
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
      { timeout: 300_000 }
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

          const after = first.next ?? "";

          const other = yield* http.get(
            listPath(LAPTOP, { after, limit: "1", sort: "-serial" }),
            { token }
          );

          const parent = yield* http.get(
            listPath(ASSET, { after, limit: "1", sort: "serial" }),
            { token }
          );

          assert.notStrictEqual(after, "");
          assert.strictEqual(other.status, 400);
          assert.strictEqual(yield* codeOf(other), "InvalidCursor");
          // serial is unknown at the parent, before the cursor is read.
          assert.strictEqual(yield* codeOf(parent), "UnknownField");
        })
    );
  });
});
