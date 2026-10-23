import { assert, describe, it } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS, SYSTEM_USER_ID } from "@std/definitions/well-known";
import { Effect, Logger, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { listResourceEvents } from "../src/events/resource-events.ts";
import { getTopic } from "../src/events/tmf688-resources.ts";
import {
  decodedImage,
  decisionHolds,
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
import { hubTestLayer, register } from "./hub-support.ts";
import {
  ACME,
  addField,
  addRole,
  addAccessRule,
  change,
  createClass,
  ensureSite,
} from "./schema-support.ts";
import { v2Callers } from "./v2-support.ts";
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
  test("a pending version retains its complete payload and unchanged-field conditions after predecessor retention", () =>
    Effect.gen(function* retained() {
      const sql = yield* SqlClient.SqlClient;
      const { id, fixture, update } = yield* asset;
      const { admin } = yield* v2Callers;
      yield* register(admin.token ?? "", "http://localhost:12345/events");
      yield* update(1);
      yield* sql`DELETE FROM core.resource_event WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid AND record_version = 1)`;
      yield* sql`DELETE FROM core.change WHERE record_id = ${id}::uuid AND record_version = 1`;

      const [pending] =
        yield* sql`SELECT status FROM core.delivery WHERE record_id = ${id}::uuid AND record_version = 2`;

      assert.strictEqual(pending?.status, "pending");
      const snapshot = yield* (yield* Catalog).refresh;
      const entries = yield* readEntries(id, 2);
      const origins = yield* readFieldOrigins(snapshot, ACME.asset);
      const context = { me: fixture.admin.id, now: 0, timeZone: "UTC" };

      const payload = payloadOf(
        snapshot,
        { roleIds: [BUILT_IN_ROLE_IDS.admin] },
        { entries, origins, recordId: id },
        context
      );

      assert.notInstanceOf(payload, Error);
      assert.propertyVal(payload, "visible", true);

      const image = decodedImage(
        snapshot,
        ACME.asset,
        versionImage(snapshot, entries, origins).known
      );

      assert.isFalse(image instanceof Error);

      if (image instanceof Error) {
        return;
      }

      assert.strictEqual(image[ACME.status], "in_use");
      assert.isTrue(
        decisionHolds(
          snapshot,
          {
            condition: {
              left: { path: [ACME.status] },
              op: "eq",
              right: { value: "in_use" },
            },
            kind: "conditional",
          },
          ACME.asset,
          image,
          context
        )
      );
      assert.strictEqual(entries[0]?.image?.[ACME.name], "one");
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("legacy middle gaps accumulate every field into the latest retained predecessor", () =>
    Effect.gen(function* gap() {
      const sql = yield* SqlClient.SqlClient;
      const { id, fixture, update } = yield* asset;
      yield* updateRecord({
        body: { cost: "12.00", purchased_on: "2026-01-02", status: "lost" },
        endpointClassId: ACME.asset,
        expectedVersion: 1,
        id,
      }).pipe(actingAs(fixture.admin.id));
      yield* update(2);
      yield* update(3);
      yield* update(4);
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid)`;
      yield* sql`DELETE FROM core.resource_event WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid AND record_version = 4)`;
      yield* sql`DELETE FROM core.change WHERE record_id = ${id}::uuid AND record_version = 4`;
      const snapshot = yield* (yield* Catalog).refresh;
      const origins = yield* readFieldOrigins(snapshot, ACME.asset);
      const image = versionImage(snapshot, yield* readEntries(id, 5), origins);
      assert.strictEqual(image.known.get(ACME.status), "lost");
      assert.strictEqual(image.known.get(ACME.cost), "12.00");
      assert.strictEqual(image.known.get(ACME.purchasedOn), "2026-01-02");
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("config writers own images and a config commit between backfill batches leaves exact zero remaining", () =>
    Effect.gen(function* config() {
      const sql = yield* SqlClient.SqlClient;
      const { request } = yield* Transactions;
      const { id, fixture, update } = yield* asset;
      yield* update(1);
      assert.strictEqual(
        yield* request(migration0027.remaining).pipe(
          actingAs(fixture.admin.id)
        ),
        0
      );

      const [system] =
        yield* sql`SELECT i.after_image FROM core.change c JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${SYSTEM_USER_ID}::uuid`;

      assert.isDefined(system);
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid)`;

      const first = yield* request(migration0027.batch(null, 1)).pipe(
        actingAs(fixture.admin.id)
      );

      yield* ensureSite;
      const table = createClass("image_config");
      const role = addRole("image_reader");
      yield* change([table.op, role.op]);
      const rule = addAccessRule(table.id, [role.id]);
      yield* change([rule.op]);

      const [bump] =
        yield* sql`SELECT c.record_version::int AS version, i.after_image IS NOT NULL AS image FROM core.change c LEFT JOIN core.change_image i ON i.change_id = c.id WHERE c.record_id = ${role.id}::uuid ORDER BY c.record_version DESC LIMIT 1`;

      assert.strictEqual(bump?.version, 2);
      assert.strictEqual(bump?.image, true);
      yield* request(migration0027.batch(first.next, 10)).pipe(
        actingAs(fixture.admin.id)
      );
      assert.strictEqual(
        yield* request(migration0027.remaining).pipe(
          actingAs(fixture.admin.id)
        ),
        0
      );
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  test("long legacy batches reduce history once, cache origins and match slow images", () =>
    Effect.gen(function* bounded() {
      const sql = yield* SqlClient.SqlClient;
      const log = yield* StatementLog;
      const { request } = yield* Transactions;
      const { id, fixture } = yield* asset;
      const historyLength = 10_000;
      const batchSize = 100;
      const firstVersion = historyLength - batchSize + 1;
      yield* sql`INSERT INTO core.change (id, class_id, version, created_at, created_by, updated_at, updated_by, operation_id, record_id, record_class_id, record_version, kind, actor_id, cause, schema_revision, occurred_at, fields)
        SELECT uuidv7(), c.class_id, c.version, c.created_at, c.created_by, c.updated_at, c.updated_by, c.operation_id, c.record_id, c.record_class_id, versions.n, 'update', c.actor_id, c.cause, c.schema_revision, c.occurred_at,
          jsonb_build_object(${ACME.name}::text, jsonb_build_object('before', CASE WHEN versions.n = 2 THEN 'one' ELSE 'version-' || (versions.n - 1)::text END, 'after', 'version-' || versions.n::text))
        FROM core.change c CROSS JOIN generate_series(2, ${historyLength}) versions(n) WHERE c.record_id = ${id}::uuid AND c.record_version = 1`;
      yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${id}::uuid)`;
      const snapshot = yield* (yield* Catalog).refresh;
      const origins = yield* readFieldOrigins(snapshot, ACME.asset);
      const slow = [];

      for (const version of Array.from(
        { length: batchSize },
        (_, index) => index + firstVersion
      )) {
        slow.push(
          versionImage(snapshot, yield* readEntries(id, version), origins)
        );
      }

      yield* log.clear;
      yield* request(
        migration0027.batch(
          JSON.stringify({ recordId: id, version: firstVersion - 1 }),
          batchSize
        )
      ).pipe(actingAs(fixture.admin.id));
      const statements = yield* log.texts;
      assert.lengthOf(
        statements.filter((text) => text.includes("WITH history")),
        1
      );
      assert.lengthOf(
        statements.filter((text) => text.includes('DISTINCT ON ("dr".')),
        1
      );
      // One selection, one origin read, one fallback, and two statements per version, plus transaction setup.
      assert.isAtMost(statements.length, 2 * batchSize + 10);

      for (const [index, expected] of slow.entries()) {
        assert.deepStrictEqual(
          versionImage(
            snapshot,
            yield* readEntries(id, index + firstVersion),
            origins
          ),
          expected
        );
      }
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

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
