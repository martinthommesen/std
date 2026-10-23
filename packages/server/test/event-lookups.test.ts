import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { API_PREFIX } from "@std/api/api";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import { eventIdOf, recordEventType } from "../src/events/event-id.ts";
import { createEvent } from "../src/events/tmf688-resources.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { DataMigrationFailed } from "../src/platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0022 } from "../src/platform/migrations/0022-event-lookup-backfill.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { asObject, textOf, apiCallers } from "./api-support.ts";
import { hubTestLayer } from "./hub-support.ts";
import { actingAs, asLoadedUser } from "./worker-support.ts";

const topicFixture = Effect.gen(function* topicFixture() {
  const http = yield* TestHttpClient;
  const { admin } = yield* apiCallers;

  const topic = yield* http.request("POST", `${TMF688_PREFIX}/topic`, {
    ...admin,
    body: { name: "lookup" },
  });

  const id = textOf(asObject(topic.json).id);

  return { admin, http, id, path: `${TMF688_PREFIX}/topic/${id}/event` };
});

const bodyOf = (id: string) => ({
  "@type": "Test",
  event: {},
  eventId: id,
  eventType: "Test",
});

const countOf = decodeRows(Schema.Struct({ total: Schema.FiniteFromString }));

const eventCount = Effect.fn("EventTest.eventCount")(function* eventCount(
  topicId: string
) {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`SELECT count(*)::text AS total FROM core.event WHERE topic = ${topicId}::uuid`.pipe(
    Effect.flatMap(countOf)
  );
});

const test = it.live;

describe("event lookups during rollout", () => {
  test("SQL lookup UUIDs match UUIDv5 for every record type and use the fallback index", () =>
    Effect.gen(function* indexedUuid() {
      const sql = yield* SqlClient.SqlClient;

      for (const kind of ["create", "update", "delete"] as const) {
        for (const namespace of [
          "00000000-0000-0000-0000-000000000000",
          randomUUID(),
          randomUUID(),
        ]) {
          const [row] =
            yield* sql`SELECT core.record_event_id(${namespace}::uuid, ${kind})::text AS id`.pipe(
              Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String })))
            );

          assert.strictEqual(
            row?.id,
            eventIdOf(namespace, recordEventType(kind))
          );
        }
      }

      const rows = yield* sql.unsafe(
        "EXPLAIN SELECT id FROM core.change WHERE core.record_event_id(id, kind) = $1::uuid LIMIT 1",
        [randomUUID()]
      );

      assert.include(JSON.stringify(rows), "change_event_key");
    }).pipe(Effect.provide(testDatabaseLayer())));

  test("TMF688 and generic creates index in the save transaction and work before backfill", () =>
    Effect.gen(function* everyCreatePath() {
      const sql = yield* SqlClient.SqlClient;
      const { request } = yield* Transactions;
      const fixture = yield* AcmeFixture;
      const { admin, http, id, path } = yield* topicFixture;
      assert.strictEqual(
        (yield* http.request("POST", path, { ...admin, body: bodyOf("tmf") }))
          .status,
        201
      );
      assert.strictEqual(
        (yield* http.request("POST", `${API_PREFIX}/coreEvent`, {
          ...admin,
          body: { payload: bodyOf("generic"), topic: { id } },
        })).status,
        201
      );

      for (const eventId of ["tmf", "generic"]) {
        assert.strictEqual(
          (yield* http.get(`${path}/${eventId}`, admin)).status,
          200
        );
      }

      yield* sql`DELETE FROM core.client_event WHERE topic_id = ${id}::uuid`;
      yield* sql`DELETE FROM core.platform_migration WHERE id = 22`;

      for (const eventId of ["tmf", "generic"]) {
        const response = yield* http.get(`${path}/${eventId}`, admin);
        assert.strictEqual(response.status, 200, response.text);
        assert.strictEqual(asObject(response.json).eventId, eventId);
        assert.strictEqual(
          (yield* http.get(`${path}?after=${eventId}`, admin)).status,
          200
        );
      }

      assert.strictEqual(
        (yield* http.get(`${path}?after=unknown`, admin)).status,
        400
      );

      // A lookup write failure rolls back the record and its history as well.
      const [before] = yield* eventCount(id);

      yield* sql.unsafe(
        "CREATE FUNCTION core.refuse_test_lookup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test lookup failure'; END $$"
      );
      yield* sql.unsafe(
        "CREATE TRIGGER refuse_test_lookup BEFORE INSERT ON core.client_event FOR EACH ROW EXECUTE FUNCTION core.refuse_test_lookup()"
      );

      const failedTmf = yield* request(
        createEvent(id, bodyOf("failed"), "http://localhost")
      ).pipe(asLoadedUser(fixture.admin.id), Effect.flip);

      assert.strictEqual(failedTmf._tag, "DatabaseError");

      const failedGeneric = yield* createRecord({
        body: { payload: bodyOf("failed"), topic: id },
        endpointClassId: EVENT_CLASS_IDS.event,
      }).pipe(actingAs(fixture.admin.id), Effect.flip);

      assert.strictEqual(failedGeneric._tag, "DatabaseError");

      const [after] = yield* eventCount(id);

      assert.strictEqual(after?.total, before?.total);
    }).pipe(Effect.provide(hubTestLayer)));

  test("0022 counts both tables, commits bounded phases, resumes after a failed batch and reaches zero", () =>
    Effect.gen(function* resumableLookupBackfill() {
      const sql = yield* SqlClient.SqlClient;
      const log = yield* StatementLog;
      const { request } = yield* Transactions;
      const fixture = yield* AcmeFixture;

      const remaining = request(migration0022.remaining).pipe(
        actingAs(fixture.admin.id)
      );

      const { admin, http, id, path } = yield* topicFixture;

      for (const eventId of ["a", "b", "c", "d", "e"]) {
        yield* http.request("POST", path, {
          ...admin,
          body: bodyOf(eventId),
        });
      }

      yield* sql`DELETE FROM core.resource_event WHERE change_id IN (SELECT id FROM core.change WHERE record_id IN (SELECT id FROM core.event WHERE topic = ${id}::uuid))`;
      yield* sql`DELETE FROM core.client_event WHERE topic_id = ${id}::uuid`;
      assert.strictEqual(yield* remaining, 10);
      yield* sql`DELETE FROM core.platform_migration WHERE id = 22`;
      let failed = false;

      const interrupting = {
        ...migration0022,
        batch: Effect.fn("Test.interruptedLookupBatch")(function* batch(
          after: string | null,
          size: number
        ) {
          if (
            after?.startsWith("client:") === true &&
            after !== "client:" &&
            !failed
          ) {
            failed = true;

            return yield* new DataMigrationFailed({
              id: 22,
              migration: "event-lookup-backfill",
              reason: "deterministic interruption",
            });
          }

          return yield* migration0022.batch(after, size);
        }),
      };

      const migrations = PLATFORM_MIGRATIONS.map((migration) =>
        migration.id === 22 ? interrupting : migration
      );

      yield* runDataMigrations({ batchSize: 2, migrations }).pipe(Effect.flip);

      const [stopped] =
        yield* sql`SELECT state, progress->>'after' AS after FROM core.platform_migration WHERE id = 22`.pipe(
          Effect.flatMap(
            decodeRows(
              Schema.Struct({ after: Schema.String, state: Schema.String })
            )
          )
        );

      assert.strictEqual(stopped?.state, "running");
      assert.include(stopped?.after ?? "", "client:");
      assert.strictEqual(yield* remaining, 3);
      yield* log.clear;
      const outcomes = yield* runDataMigrations({ batchSize: 2 });
      assert.strictEqual(outcomes[0]?.outcome, "resumed");
      assert.strictEqual(yield* remaining, 0);
      assert.isTrue(
        (yield* log.texts)
          .filter((text) => text.includes("SELECT id::text, topic::text"))
          .every((text) => text.includes("LIMIT $2"))
      );
      assert.deepStrictEqual(yield* runDataMigrations({ batchSize: 2 }), []);
    }).pipe(Effect.provide(hubTestLayer)));
});
