/** Step 3 prerequisites for the rolling-upgrade protocol (Contracts 8.8). */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { Duration, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../src/catalog/catalog.ts";
import { readLayerState } from "../src/config/layer-store.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { claimDeliveries, markDone } from "../src/outbox/delivery-claims.ts";
import { readLedger } from "../src/platform/ledger.ts";
import { migrationChecksum } from "../src/platform/migration.ts";
import { migration0017 } from "../src/platform/migrations/0017-rolling-groundwork.ts";
import { checkUpgradePreconditions } from "../src/platform/runner.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import {
  CLI_APPLICATION_NAME,
  SERVER_APPLICATION_NAME,
  WORKER_APPLICATION_NAME,
} from "../src/sql/database-config.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { STD_VERSION } from "../src/version.ts";
import { outboxTestLayer, subscribe } from "./outbox-support.ts";
import { setUpAcme } from "./records-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  addField,
  addRole,
} from "./schema-support.ts";

const FUTURE_ID = "9b8da80b-93d0-4a29-877c-e9a1d8e2c303";
const FUTURE_VERSION = "999.0.0";
const decodeText = decodeRows(Schema.Struct({ value: Schema.String }));

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
  it.effect(
    "names server, worker and CLI connections with the package version",
    () =>
      Effect.sync(() => {
        assert.strictEqual(
          SERVER_APPLICATION_NAME,
          `std-server@${STD_VERSION}`
        );
        assert.strictEqual(
          WORKER_APPLICATION_NAME,
          `std-worker@${STD_VERSION}`
        );
        assert.strictEqual(CLI_APPLICATION_NAME, `std-cli@${STD_VERSION}`);
      })
  );

  layer(outboxTestLayer(), { excludeTestServices: true })((dbTest) => {
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
          assert.strictEqual(ledger.length, 17);
          assert.isTrue(ledger.every((entry) => entry.phase === "expand"));
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
});
