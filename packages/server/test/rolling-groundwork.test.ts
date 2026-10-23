/** Step 3 prerequisites for the rolling-upgrade protocol (Contracts 8.8). */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Duration, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { readLayerState } from "../src/config/layer-store.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { claimDeliveries, markDone } from "../src/outbox/delivery-claims.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
import { readLedger } from "../src/platform/ledger.ts";
import type { DataMigration } from "../src/platform/migration.ts";
import { migrationChecksum } from "../src/platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../src/platform/migrations.ts";
import { migration0017 } from "../src/platform/migrations/0017-rolling-groundwork.ts";
import { checkUpgradePreconditions } from "../src/platform/runner.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { STD_VERSION } from "../src/version.ts";
import { startServe, startWorker } from "./cli-support.ts";
import { outboxTestLayer, subscribe } from "./outbox-support.ts";
import { setUpAcme } from "./records-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  addField,
  addRole,
} from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const FUTURE_ID = "9b8da80b-93d0-4a29-877c-e9a1d8e2c303";
const FUTURE_VERSION = "999.0.0";
const decodeText = decodeRows(Schema.Struct({ value: Schema.String }));

const workerConnected = (
  rows: readonly { readonly value: string }[]
): boolean => rows.some((row) => row.value === `std-worker@${STD_VERSION}`);

const storedUnknown = Effect.gen(function* storedUnknown() {
  const sql = yield* SqlClient.SqlClient;

  return yield* decodeText(
    yield* sql`
    SELECT jsonb_build_object('base', to_jsonb(b), 'overrides',
      (SELECT jsonb_agg(to_jsonb(o)) FROM core.config_override o WHERE record_id = b.id),
      'edges', (SELECT jsonb_agg(to_jsonb(d) ORDER BY from_id, kind, to_id)
        FROM core.config_dependency d WHERE kind = 'future_edge'))::text AS value
    FROM core.config_base b WHERE id = ${FUTURE_ID}::uuid`
  );
});

describe("rolling-groundwork", () => {
  it("uses different hashes for expand and contract on new migrations", () => {
    assert.notStrictEqual(
      migrationChecksum(migration0017),
      migrationChecksum({ ...migration0017, phase: "contract" })
    );
  });
  layer(outboxTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "real server and worker connections expose the release version",
      () =>
        Effect.scoped(
          Effect.gen(function* applicationNames() {
            yield* runUpgrade({ sets: [ACME_SET_DIRECTORY] });
            const database = yield* TestDatabase;
            const server = yield* startServe(database.url);
            const worker = yield* startWorker(database.url);
            const sql = yield* SqlClient.SqlClient;

            const names =
              sql`SELECT DISTINCT application_name AS value FROM pg_stat_activity
          WHERE datname = current_database() AND application_name LIKE 'std-%'`.pipe(
                Effect.flatMap(decodeText)
              );

            yield* waitUntil(names.pipe(Effect.map(workerConnected)));
            const actual = (yield* names).map((row) => row.value);
            assert.include(actual, `std-server@${STD_VERSION}`, server.log());
            assert.include(actual, `std-worker@${STD_VERSION}`, worker.log());

            for (const name of actual.filter((value) =>
              /std-(?:server|worker|coordinator|resumer)(?:@|$)/u.test(value)
            )) {
              assert.match(
                name,
                new RegExp(`@${STD_VERSION.replaceAll(".", "\\.")}$`, "u")
              );
            }
          })
        )
    );

    dbTest.effect(
      "release version fits the delivery constraint and PostgreSQL numeric comparison",
      () =>
        Effect.gen(function* versionProtocol() {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* decodeRows(
            Schema.Struct({ matches: Schema.Boolean, ordered: Schema.Boolean })
          )(
            yield* sql`SELECT ${STD_VERSION} ~ substring(pg_get_constraintdef(oid) FROM $$'([^']+)'$$) AS matches,
            string_to_array(${STD_VERSION}, '.')::numeric[] > string_to_array('0.0.0', '.')::numeric[]
            AND string_to_array('0.0.10', '.')::numeric[] > string_to_array('0.0.9', '.')::numeric[]
            AS ordered
            FROM pg_constraint WHERE conrelid = 'core.delivery'::regclass AND conname = 'delivery_min_worker_version'`
          );

          assert.deepStrictEqual(rows, [{ matches: true, ordered: true }]);
        })
    );

    dbTest.effect(
      "preserves newer config and dependency kinds across loading, change sets and doctor",
      () =>
        Effect.gen(function* scenario1() {
          yield* runUpgrade({ sets: [ACME_SET_DIRECTORY] });

          const field = addField(ACME.asset, "future_tolerance_probe", {
            kind: "text",
          });

          yield* applyChangeSet({ operations: [field.op] });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
        INSERT INTO core.config_base (id, class_id, version, created_at, created_by,
          updated_at, updated_by, set_id, set_version, kind, shipped, hash, removed)
        SELECT ${FUTURE_ID}::uuid, class_id, 1, now(), ${SYSTEM_USER_ID}::uuid,
          now(), ${SYSTEM_USER_ID}::uuid, set_id, set_version, 'future_config',
          '{"future":true}'::jsonb, 'future hash format', false
        FROM core.config_base LIMIT 1`;
          yield* sql`INSERT INTO core.config_override
        (id, class_id, version, created_at, created_by, updated_at, updated_by,
          record_id, property, value, base_when_set, set_by, set_at)
        VALUES (uuidv7(), ${PLATFORM_CLASS_IDS.config_override}::uuid, 1, now(), ${SYSTEM_USER_ID}::uuid,
          now(), ${SYSTEM_USER_ID}::uuid, ${FUTURE_ID}::uuid, 'future_property', 'true', 'false', ${SYSTEM_USER_ID}::uuid, now())`;
          // A known definition is changed below: rebuilding its known edges must
          // preserve the edge only a future release understands.
          yield* sql`INSERT INTO core.config_dependency (from_id, to_id, kind)
        VALUES (${field.id}::uuid, ${FUTURE_ID}::uuid, 'future_edge')`;
          yield* sql.unsafe(
            "CREATE TABLE core.future_platform (id integer PRIMARY KEY)"
          );
          const before = yield* storedUnknown;
          const layers = yield* readLayerState;
          const snapshot = yield* (yield* Catalog).refresh;
          assert.isFalse(layers.base.has(FUTURE_ID));
          assert.isFalse(
            layers.overrides.some((override) => override.recordId === FUTURE_ID)
          );
          assert.isUndefined(snapshot.get(FUTURE_ID));
          const known = snapshot.field(field.id);
          assert.isDefined(known);

          if (known === undefined) {
            return;
          }

          yield* applyChangeSet({
            operations: [
              {
                changes: { label: "Known field" },
                id: known.id,
                op: "update",
                version: known.version,
              },
            ],
          });
          const report = yield* runDoctor();
          assert.strictEqual(
            report.exitCode,
            0,
            JSON.stringify(report.findings)
          );

          for (const code of [
            "newerConfigKind",
            "newerDependencyKind",
            "newerPlatformTable",
          ]) {
            assert.isTrue(
              report.findings.some(
                (finding) =>
                  finding.code === code && finding.severity === "info"
              ),
              code
            );
          }

          assert.deepStrictEqual(yield* storedUnknown, before);
        })
    );

    dbTest.effect(
      "config deliveries carry the package worker-version floor",
      () =>
        Effect.gen(function* configFloor() {
          yield* runUpgrade({ sets: [ACME_SET_DIRECTORY] });

          const subscriptionId = yield* subscribe({
            classId: PLATFORM_CLASS_IDS.role,
            identityId: SYSTEM_USER_ID,
          });

          const role = addRole("version_floor_probe");
          yield* applyChangeSet({ operations: [role.op] });
          const sql = yield* SqlClient.SqlClient;

          const versions = yield* decodeText(
            yield* sql`SELECT min_worker_version AS value FROM core.delivery WHERE subscription_id = ${subscriptionId}::uuid AND record_id = ${role.id}::uuid`
          );

          assert.deepStrictEqual(versions, [{ value: STD_VERSION }]);
        })
    );

    dbTest.effect(
      "records every applied phase including the pre-phase migrations",
      () =>
        Effect.gen(function* scenario2() {
          yield* runUpgrade({ sets: [ACME_SET_DIRECTORY] });
          const ledger = yield* readLedger(yield* SqlClient.SqlClient);

          const applicable = PLATFORM_MIGRATIONS.filter(
            (migration) =>
              migration.kind !== "data" || migration.requiredSet === undefined
          );

          assert.deepStrictEqual(
            ledger.map((entry) => entry.id),
            applicable.map((migration) => migration.id)
          );

          for (const migration of applicable) {
            assert.strictEqual(
              ledger.find((entry) => entry.id === migration.id)?.phase,
              migration.phase
            );
          }
        })
    );

    dbTest.effect(
      "refuses upgrades beside any server or worker release but allows CLI releases",
      () =>
        Effect.scoped(
          Effect.gen(function* scenario3() {
            const sql = yield* SqlClient.SqlClient;

            for (const applicationName of [
              "std-server@0.0.2",
              "std-worker@999.0.0",
              "std-server",
              "std-worker",
            ]) {
              yield* Effect.scoped(
                Effect.gen(function* scenario4() {
                  yield* makeDedicatedConnection({ applicationName });

                  const result = yield* Effect.result(
                    checkUpgradePreconditions(sql)
                  );

                  assert.strictEqual(result._tag, "Failure", applicationName);
                })
              );
            }

            yield* makeDedicatedConnection({
              applicationName: "std-cli@999.0.0",
            });
            assert.deepStrictEqual(yield* checkUpgradePreconditions(sql), []);
          })
        )
    );

    dbTest.effect(
      "skips newer-worker deliveries without overtaking their record or blocking other records",
      () =>
        Effect.gen(function* scenario5() {
          yield* setUpAcme;
          const subscriptionId = yield* subscribe({ classId: ACME.asset });

          const first = yield* createRecord({
            body: { name: "First", status: "in_use" },
            endpointClassId: ACME.asset,
          });

          const second = yield* createRecord({
            body: { name: "Other", status: "in_use" },
            endpointClassId: ACME.asset,
          });

          yield* updateRecord({
            body: { name: "Later" },
            endpointClassId: ACME.asset,
            expectedVersion: first.version,
            id: first.id,
          });
          const sql = yield* SqlClient.SqlClient;

          const versions = yield* decodeText(
            yield* sql`SELECT DISTINCT min_worker_version AS value FROM core.delivery WHERE subscription_id = ${subscriptionId}::uuid`
          );

          assert.deepStrictEqual(versions, [{ value: STD_VERSION }]);
          yield* sql`UPDATE core.delivery SET min_worker_version = ${FUTURE_VERSION}
        WHERE subscription_id = ${subscriptionId}::uuid AND record_id = ${first.id}::uuid AND record_version = 1`;

          const input = {
            deadLetter: "block" as const,
            lease: Duration.minutes(1),
            limit: 20,
            maxAttempts: 10,
            subscriptionId,
          };

          const claimed = yield* claimDeliveries(input);
          assert.deepStrictEqual(
            claimed.map((row) => row.recordId),
            [second.id]
          );

          for (const row of claimed) {
            yield* markDone(row);
          }

          assert.deepStrictEqual(yield* claimDeliveries(input), []);
          yield* sql`UPDATE core.delivery SET min_worker_version = '0.0.0' WHERE record_id = ${first.id}::uuid`;
          const available = yield* claimDeliveries(input);
          assert.deepStrictEqual(
            available.map((row) => row.recordVersion),
            [1]
          );

          for (const row of available) {
            yield* markDone(row);
          }

          assert.deepStrictEqual(
            (yield* claimDeliveries(input)).map((row) => row.recordVersion),
            [2]
          );
        })
    );
  });
  layer(outboxTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "data migrations work on a ledger that predates phase metadata",
      () =>
        Effect.gen(function* prePhaseDataMigration() {
          yield* runUpgrade({ sets: [ACME_SET_DIRECTORY] });
          const sql = yield* SqlClient.SqlClient;
          // A pre-phase ledger predates the first contract migration. Restore
          // that historical prefix before removing its phase column.
          yield* sql`DELETE FROM core.platform_migration WHERE id > 17`;
          yield* sql.unsafe(
            "ALTER TABLE core.platform_migration DROP COLUMN phase"
          );

          const migration: DataMigration = {
            batch: () => Effect.succeed({ changed: 0, next: null }),
            description: "No-op probe of a pre-phase data ledger",
            id: 18,
            kind: "data",
            name: "pre-phase-probe",
            phase: "expand",
            remaining: Effect.succeed(0),
          };

          yield* runDataMigrations({
            migrations: [
              ...PLATFORM_MIGRATIONS.filter((entry) => entry.id <= 17),
              migration,
            ],
          });
          const ledger = yield* readLedger(sql);
          assert.deepStrictEqual(ledger.at(-1), {
            checksum: migrationChecksum(migration),
            id: 18,
            phase: "expand",
            progress: '{"changed": 0}',
            state: "applied",
          });
        })
    );
  });
});
