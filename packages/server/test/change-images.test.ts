import { assert, describe, it } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Effect, Logger, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { listResourceEvents } from "../src/events/resource-events.ts";
import { getTopic } from "../src/events/tmf688-resources.ts";
import {
  payloadOf,
  readEntries,
  readFieldOrigins,
  versionImage,
} from "../src/outbox/delivery-payload.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { DataMigrationFailed } from "../src/platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0027 } from "../src/platform/migrations/0027-change-image-backfill.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { hubTestLayer } from "./hub-support.ts";
import {
  ACME,
  addField,
  change,
  createClass,
  ensureSite,
} from "./schema-support.ts";
import { actingAs, asLoadedUser } from "./worker-support.ts";

const test = it.effect;

const imageRows = decodeRows(
  Schema.Struct({
    after: Schema.Boolean,
    before: Schema.Boolean,
    version: Schema.Int,
  })
);

const asset = Effect.gen(function* asset() {
  const fixture = yield* AcmeFixture;

  const saved = yield* createRecord({
    body: { name: "one", status: "in_use" },
    endpointClassId: ACME.asset,
  }).pipe(actingAs(fixture.admin.id));

  const update = (version: number) =>
    updateRecord({
      body: { name: `version-${version + 1}` },
      endpointClassId: ACME.asset,
      expectedVersion: version,
      id: saved.id,
    }).pipe(actingAs(fixture.admin.id));

  const remove = (version: number) =>
    deleteRecord({
      endpointClassId: ACME.asset,
      expectedVersion: version,
      id: saved.id,
    }).pipe(actingAs(fixture.admin.id));

  return { fixture, id: saved.id, remove, update };
});

describe("change images", () => {
  test("unreadable resource payloads warn with their change ID and leave other events readable", () =>
    Effect.gen(function* unreadableEvent() {
      const sql = yield* SqlClient.SqlClient;
      const good = yield* asset;
      const broken = yield* asset;

      const [row] =
        yield* sql`UPDATE core.change_image i SET after_image = jsonb_set(i.after_image, ARRAY[${ACME.name}], '42'::jsonb) FROM core.change c WHERE i.change_id = c.id AND c.record_id = ${broken.id}::uuid RETURNING i.change_id::text AS id`.pipe(
          Effect.flatMap(decodeRows(Schema.Struct({ id: Schema.String })))
        );

      const warnings: string[] = [];

      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") {
          warnings.push(JSON.stringify(message));
        }
      });

      const { request } = yield* Transactions;

      const page = yield* request(
        Effect.gen(function* read() {
          const topic = yield* getTopic("record:acmeAsset", "http://localhost");

          return yield* listResourceEvents(topic, "http://localhost", {
            limit: 10,
          });
        })
      ).pipe(
        asLoadedUser(good.fixture.admin.id),
        Effect.provide(Logger.layer([logger]))
      );

      assert.include(JSON.stringify(page.events), good.id);
      assert.notInclude(JSON.stringify(page.events), broken.id);
      assert.lengthOf(warnings, 1);
      assert.include(warnings[0] ?? "", row?.id ?? "missing-change");
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("updates store only after-images, gaps bridge once, and deletes reuse the preceding image", () =>
    Effect.gen(function* storage() {
      const sql = yield* SqlClient.SqlClient;
      const { id, update, remove } = yield* asset;
      yield* update(1);

      const [normal] =
        yield* sql`SELECT before_image IS NOT NULL AS before, after_image IS NOT NULL AS after, c.record_version::int AS version FROM core.change c JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${id}::uuid AND c.record_version = 2`.pipe(
          Effect.flatMap(imageRows)
        );

      assert.deepStrictEqual(normal, {
        after: true,
        before: false,
        version: 2,
      });
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid)`;
      yield* update(2);
      yield* update(3);
      yield* remove(4);

      const rows =
        yield* sql`SELECT before_image IS NOT NULL AS before, after_image IS NOT NULL AS after, c.record_version::int AS version FROM core.change c LEFT JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${id}::uuid ORDER BY c.record_version`.pipe(
          Effect.flatMap(imageRows)
        );

      assert.deepStrictEqual(rows.slice(2), [
        { after: true, before: true, version: 3 },
        { after: true, before: false, version: 4 },
        { after: false, before: false, version: 5 },
      ]);
      assert.strictEqual(
        (yield* readEntries(id, 3))[0]?.image?.[ACME.name],
        "version-2"
      );
      assert.strictEqual(
        (yield* readEntries(id, 5)).at(-1)?.image?.[ACME.name],
        "version-4"
      );

      const legacy = yield* asset;
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${legacy.id}::uuid)`;
      yield* legacy.remove(1);

      const [deleted] =
        yield* sql`SELECT before_image IS NOT NULL AS before, after_image IS NOT NULL AS after, c.record_version::int AS version FROM core.change c JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${legacy.id}::uuid AND c.kind = 'delete'`.pipe(
          Effect.flatMap(imageRows)
        );

      assert.deepStrictEqual(deleted, {
        after: false,
        before: true,
        version: 2,
      });
      assert.strictEqual(
        (yield* readEntries(legacy.id, 2)).at(-1)?.image?.[ACME.name],
        "one"
      );
      // Retention deletes the derived row along with its eligible change.
      yield* sql`DELETE FROM core.resource_event WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${legacy.id}::uuid)`;
      yield* sql`DELETE FROM core.change WHERE record_id = ${legacy.id}::uuid`;
      assert.deepStrictEqual(yield* readEntries(legacy.id, 2), []);
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("0027 resumes committed version batches and preserves legacy payloads using one image query after finalize", () =>
    Effect.gen(function* backfill() {
      const sql = yield* SqlClient.SqlClient;
      const log = yield* StatementLog;
      const { request } = yield* Transactions;
      const { id, fixture, update, remove } = yield* asset;

      for (const version of [1, 2, 3, 4]) {
        yield* update(version);
      }

      yield* remove(5);
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid)`;
      // Retained history can have a gap: finalize must preserve fail-closed images too.
      yield* sql`DELETE FROM core.resource_event WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid AND record_version = 2)`;
      yield* sql`DELETE FROM core.change WHERE record_id = ${id}::uuid AND record_version = 2`;
      const versions = [1, 3, 4, 5, 6];
      const snapshot = yield* (yield* Catalog).refresh;

      const origins = yield* request(
        readFieldOrigins(snapshot, ACME.asset)
      ).pipe(actingAs(fixture.admin.id));

      const caller = { roleIds: [BUILT_IN_ROLE_IDS.admin] };
      const context = { me: fixture.admin.id, now: 0, timeZone: "UTC" };
      const payloads = [];
      const previousImages = [];

      for (const version of versions) {
        const entries = yield* readEntries(id, version);
        previousImages.push(
          versionImage(snapshot, entries.slice(0, -1), origins)
        );
        payloads.push(
          payloadOf(
            snapshot,
            caller,
            {
              entries,
              origins,
              recordId: id,
            },
            context
          )
        );
      }

      const remaining = request(migration0027.remaining).pipe(
        actingAs(fixture.admin.id)
      );

      assert.strictEqual(yield* remaining, 5);
      yield* sql`DELETE FROM core.platform_migration WHERE id = 27`;
      let interrupted = false;

      const interrupting = {
        ...migration0027,
        batch: Effect.fn("Test.interruptedImageBatch")(function* batch(
          after: string | null,
          size: number
        ) {
          if (after !== null && !interrupted) {
            interrupted = true;

            return yield* new DataMigrationFailed({
              id: 27,
              migration: migration0027.name,
              reason: "deterministic interruption",
            });
          }

          return yield* migration0027.batch(after, size);
        }),
      };

      yield* runDataMigrations({
        batchSize: 2,
        migrations: PLATFORM_MIGRATIONS.map((migration) =>
          migration.id === 27 ? interrupting : migration
        ),
      }).pipe(Effect.flip);
      assert.strictEqual(yield* remaining, 3);
      const outcomes = yield* runDataMigrations({ batchSize: 2 });
      assert.strictEqual(outcomes[0]?.outcome, "resumed");
      assert.strictEqual(yield* remaining, 0);

      for (const [index, version] of versions.entries()) {
        yield* log.clear;
        const entries = yield* readEntries(id, version);
        const statements = yield* log.texts;
        assert.lengthOf(statements, 1);
        assert.notInclude(statements[0] ?? "", "WITH history");
        assert.deepStrictEqual(
          versionImage(snapshot, entries.slice(0, -1), origins),
          previousImages[index]
        );
        assert.deepStrictEqual(
          payloadOf(
            snapshot,
            caller,
            { entries, origins, recordId: id },
            context
          ),
          payloads[index]
        );
      }

      assert.deepStrictEqual(yield* runDataMigrations({ batchSize: 2 }), []);
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("a forty-field save stores one measured JSONB image per update", () =>
    Effect.gen(function* storageBytes() {
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* AcmeFixture;
      yield* ensureSite;
      const table = createClass("image_size");

      const fields = Array.from({ length: 40 }, (_, index) =>
        addField(table.id, `field_${index}`, { kind: "text", maxLength: 80 })
      );

      yield* change([table.op, ...fields.map((field) => field.op)]);

      const body = Object.fromEntries(
        fields.map((_, index) => [
          `field_${index}`,
          `value-${String(index).padStart(2, "0")}-abcdefghijkl`,
        ])
      );

      const saved = yield* createRecord({
        body,
        endpointClassId: table.id,
      }).pipe(actingAs(fixture.admin.id));

      yield* updateRecord({
        body: { field_0: "changed-abcdefghijkl" },
        endpointClassId: table.id,
        expectedVersion: 1,
        id: saved.id,
      }).pipe(actingAs(fixture.admin.id));

      const [size] =
        yield* sql`SELECT pg_column_size(i.after_image || '{}'::jsonb) AS image_bytes, pg_column_size(i) AS row_bytes, pg_column_size(c) AS change_bytes, i.before_image IS NULL AS single_image FROM core.change c JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${saved.id}::uuid AND c.record_version = 2`.pipe(
          Effect.flatMap(
            decodeRows(
              Schema.Struct({
                change_bytes: Schema.Int,
                image_bytes: Schema.Int,
                row_bytes: Schema.Int,
                single_image: Schema.Boolean,
              })
            )
          )
        );

      assert.isTrue(size?.single_image);
      assert.isAbove(size?.image_bytes ?? 0, 2000);
      assert.isBelow(size?.image_bytes ?? 0, 4000);
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));
});
