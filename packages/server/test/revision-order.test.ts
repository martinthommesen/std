/**
 * Numbers ordered as numbers (review round 3 of workstream 3B; Contracts
 * 4.4: readers order by the bigint column, never by its text). Each case
 * crosses a digit boundary, where text order differs: "10" sorts before
 * "9".
 *
 * - The history reader of deleted records returns versions 1 to 12 in
 *   order.
 * - The reader of open change sets returns them by first revision, 999
 *   before 1000, so the resumer resumes the older first.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { openChangeSets } from "../src/schema/recovery.ts";
import { readHistory, recordsTestLayer, setUpAcme } from "./records-support.ts";
import { ACME, values } from "./schema-support.ts";

const UPDATES = 10;

const deletedHistory = Effect.gen(function* deletedHistoryTest() {
  const created = yield* createRecord({
    body: { name: "v1", status: "in_use" },
    endpointClassId: ACME.asset,
  });

  for (let version = 1; version <= UPDATES; version += 1) {
    yield* updateRecord({
      body: { name: `v${version + 1}` },
      endpointClassId: ACME.asset,
      expectedVersion: version,
      id: created.id,
    });
  }

  yield* deleteRecord({
    endpointClassId: ACME.asset,
    expectedVersion: UPDATES + 1,
    id: created.id,
  });

  const { entries } = yield* readHistory({
    readable: new Set(),
    recordId: created.id,
    selection: {
      after: null,
      before: null,
      count: true,
      kind: "page",
      limit: UPDATES + 2,
      range: null,
      reversed: false,
    },
  });

  assert.deepStrictEqual(
    entries.map((entry) => entry.version),
    Array.from({ length: UPDATES + 2 }, (_, index) => index + 1)
  );
});

// An open change set at a revision, as table owner.
const openAt = (revision: number) =>
  values(
    `INSERT INTO core."schema_change" (id, class_id, version, created_at, created_by,
       updated_at, updated_by, requester_id, source, operations, state,
       first_revision, last_revision, committed_at, completed_at)
     VALUES ($1::uuid, $2::uuid, 1, now(), $3::uuid, now(), $3::uuid, $3::uuid,
       '{"kind":"api"}'::jsonb, '[]'::jsonb, 'applying', $4::int8, $4::int8,
       now(), NULL)
     RETURNING id::text AS value`,
    [
      randomUUID(),
      PLATFORM_CLASS_IDS.schema_change,
      SYSTEM_USER_ID,
      String(revision),
    ]
  ).pipe(Effect.map(([id]) => id ?? ""));

const openOrder = Effect.gen(function* openOrderTest() {
  const sql = yield* SqlClient.SqlClient;
  const later = yield* openAt(1000);
  const earlier = yield* openAt(999);

  const open = yield* openChangeSets((text, params = []) =>
    sql.unsafe(text, params).pipe(Effect.orDie)
  );

  assert.deepStrictEqual(
    open.map((changeSet) => [changeSet.id, changeSet.firstRevision]),
    [
      [earlier, 999],
      [later, 1000],
    ]
  );

  yield* values(
    `DELETE FROM core."schema_change" WHERE id = ANY($1::uuid[]) RETURNING id::text AS value`,
    [[earlier, later]]
  );
});

describe("revision-order", () => {
  it("crosses a digit boundary", () => {
    assert.deepStrictEqual(["9", "10"].toSorted(), ["10", "9"], "text order");
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "a deleted record's history lists versions 1 to 12 in number order",
      () => deletedHistory
    );

    dbTest.effect(
      "open change sets come oldest first: first revision 999 before 1000",
      () => openOrder
    );
  });
});
