/**
 * History storage and query (Contracts 3.7, 4.2, 4.3, 4.5) with an explicit
 * readable-field set, and error hygiene of the save pipeline (3.8).
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";

import { assert, describe, it, layer } from "@effect/vitest";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { Cause, Effect, Exit } from "effect";

import type {
  HistoryEntry,
  HistoryFilter,
  HistorySelection,
} from "../src/records/history-query.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import {
  asUser,
  recordsTestLayer,
  readHistory,
  setUpAcme,
  USERS,
} from "./records-support.ts";
import { ACME } from "./schema-support.ts";

/** Every field of a laptop except `cost`. */
const READABLE_WITHOUT_COST: ReadonlySet<string> = new Set([
  ACME.name,
  ACME.status,
  ACME.purchasedOn,
  ACME.serial,
]);

// This fixture creates at most four versions; one lookahead belongs to SQL paging.
const HISTORY_PAGE: HistorySelection = {
  after: null,
  before: null,
  count: true,
  kind: "page",
  limit: 4,
  range: null,
  reversed: false,
};

const POSTGRES_TEXT = [
  "duplicate key",
  "violates",
  "Key (",
  "is not present",
  "is still referenced",
  'constraint "',
];

const renderings = <A, E>(exit: Exit.Exit<A, E>): readonly string[] =>
  Exit.isFailure(exit)
    ? [
        Cause.pretty(exit.cause),
        inspect(exit.cause, { depth: 20 }),
        JSON.stringify(exit.cause.reasons),
      ]
    : [];

const assertHygienic = <A, E>(
  exit: Exit.Exit<A, E>,
  privateValues: readonly string[]
): void => {
  assert.isTrue(Exit.isFailure(exit));

  for (const rendered of renderings(exit)) {
    for (const text of [...POSTGRES_TEXT, ...privateValues]) {
      assert.notInclude(rendered, text);
    }
  }
};

const toVersions = (entries: readonly HistoryEntry[]): readonly number[] =>
  entries.map((entry) => entry.version);

const versionsOf = (recordId: string, filter: HistoryFilter) =>
  readHistory({
    filter,
    readable: READABLE_WITHOUT_COST,
    recordId,
    selection: HISTORY_PAGE,
  }).pipe(Effect.map(({ entries }) => toVersions(entries)));

describe("record-history", () => {
  it("never returns a field outside the readable set", () => {
    assert.deepStrictEqual(toVersions([]), []);
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "history leaves out unreadable fields and keeps entries without visible changes",
      () =>
        Effect.gen(function* history() {
          const laptop = yield* createRecord({
            body: {
              cost: "1200.00",
              name: "L",
              purchased_on: "2026-01-01",
              serial: "SN-1",
            },
            endpointClassId: ACME.laptop,
          });

          yield* updateRecord({
            body: { cost: "1300.00", status: "in_use" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          });

          yield* updateRecord({
            body: { cost: "1400.00" },
            endpointClassId: ACME.asset,
            expectedVersion: 2,
            id: laptop.id,
          });

          yield* updateRecord({
            body: { serial: "SN-2" },
            endpointClassId: ACME.laptop,
            expectedVersion: 3,
            id: laptop.id,
          }).pipe(asUser(USERS.bob));

          const { entries } = yield* readHistory({
            readable: READABLE_WITHOUT_COST,
            recordId: laptop.id,
            selection: HISTORY_PAGE,
          });

          assert.deepStrictEqual(
            entries.map((entry) => `${entry.version}:${entry.kind}`),
            ["1:create", "2:update", "3:update", "4:update"]
          );

          for (const entry of entries) {
            assert.notProperty(entry.fields, ACME.cost);
          }

          assert.deepStrictEqual(entries[1]?.fields, {
            [ACME.status]: { after: "in_use", before: null },
          });
          assert.deepStrictEqual(entries[2]?.fields, {});
          assert.strictEqual(entries[2]?.actorId, USERS.alice);
          assert.deepStrictEqual(entries[3]?.fields, {
            [ACME.serial]: { after: "SN-2", before: "SN-1" },
          });
          assert.deepStrictEqual(entries[3]?.cause, { kind: "api" });

          const { entries: withCost } = yield* readHistory({
            readable: new Set([...READABLE_WITHOUT_COST, ACME.cost]),
            recordId: laptop.id,
            selection: HISTORY_PAGE,
          });

          assert.deepStrictEqual(withCost[2]?.fields, {
            [ACME.cost]: { after: "1400.00", before: "1300.00" },
          });

          const filtered = (filter: HistoryFilter) =>
            versionsOf(laptop.id, filter);

          assert.deepStrictEqual(
            yield* filtered({ actorIds: [USERS.bob] }),
            [4]
          );
          assert.deepStrictEqual(yield* filtered({ kinds: ["create"] }), [1]);
          assert.deepStrictEqual(
            yield* filtered({ fieldIds: [ACME.serial] }),
            [1, 4]
          );
          assert.deepStrictEqual(
            yield* filtered({ fieldIds: [ACME.cost] }),
            [],
            "a filter on an unreadable field matches nothing"
          );

          const first = entries[0]?.occurredAt ?? 0;

          assert.deepStrictEqual(
            yield* filtered({ since: first, until: first + 3_600_000 }),
            [1, 2, 3, 4]
          );
          assert.deepStrictEqual(yield* filtered({ until: first }), []);
        })
    );

    dbTest.effect("a delete's entry holds every non-empty before value", () =>
      Effect.gen(function* deleteEntry() {
        const monitor = yield* createRecord({
          body: { name: "M", size_inches: 27 },
          endpointClassId: ACME.monitor,
        });

        yield* deleteRecord({
          endpointClassId: ACME.asset,
          expectedVersion: 1,
          id: monitor.id,
        }).pipe(asUser(USERS.bob));

        const { entries } = yield* readHistory({
          readable: new Set([
            ACME.name,
            "9ecc19c5-8401-4887-ac05-d5dbdd937297",
          ]),
          recordId: monitor.id,
          selection: HISTORY_PAGE,
        });

        assert.deepStrictEqual(entries[1]?.fields, {
          [ACME.name]: { after: null, before: "M" },
          "9ecc19c5-8401-4887-ac05-d5dbdd937297": { after: null, before: 27 },
        });
        assert.strictEqual(entries[1]?.kind, "delete");
        assert.strictEqual(entries[1]?.version, 2);
      })
    );

    dbTest.effect(
      "constraint violations never return Postgres text or values",
      () =>
        Effect.gen(function* hygiene() {
          const login = `private-login-${randomUUID()}`;

          yield* createRecord({
            body: { login, name: "Dana" },
            endpointClassId: USER_CLASS_ID,
          });

          const duplicate = yield* createRecord({
            body: { login, name: "Dana Two" },
            endpointClassId: USER_CLASS_ID,
          }).pipe(Effect.exit);

          assertHygienic(duplicate, [login]);

          const monitor = yield* createRecord({
            body: { name: "referenced" },
            endpointClassId: ACME.monitor,
          });

          yield* createRecord({
            body: { docked_to: monitor.id, name: "dock" },
            endpointClassId: ACME.monitor,
          });

          const referenced = yield* deleteRecord({
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: monitor.id,
          }).pipe(Effect.exit);

          assertHygienic(referenced, [monitor.id]);

          const unknownActor = randomUUID();

          const unmapped = yield* createRecord({
            body: { name: "orphan" },
            endpointClassId: ACME.monitor,
          })
            .pipe(asUser(unknownActor))
            .pipe(Effect.exit);

          assertHygienic(unmapped, [unknownActor, "orphan"]);
          assert.include(
            renderings(unmapped).join(" "),
            "DatabaseError",
            "an unmapped violation stays a DatabaseError"
          );
        })
    );
  });
});
