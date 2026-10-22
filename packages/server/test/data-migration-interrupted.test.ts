/**
 * `data-migration-interrupted` (Contracts 1.9, 1.10 check 1, 8.5;
 * decision 0024): a `std upgrade` killed between the batches of a `data`
 * migration leaves its ledger row `running` with the progress of the last
 * committed batch; `std serve` refuses to start and names it; `doctor`
 * exits 1 with `dataMigrationIncomplete`; a rerun of `std upgrade`
 * completes it and `doctor` exits 0; a second rerun changes nothing.
 *
 * The run is stopped at a known point: the test holds a row lock on one
 * user in the second batch, waits until the first batch committed and the
 * upgrade waits for that lock, then kills the process with SIGKILL.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { DATA_BATCH_SIZE } from "../src/platform/data-migrations.ts";
import { CLI_APPLICATION_NAME } from "../src/sql/database-config.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { runCli, startServe } from "./cli-support.ts";
import { schemaTestLayer, values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";

/** Users the old release left without individuals. */
const OLD_USERS = 3 * DATA_BATCH_SIZE;

const LedgerRowSchema = Schema.Struct({
  progress: Schema.NullOr(Schema.String),
  state: Schema.String,
});

const decodeLedgerRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LedgerRowSchema)
);

/** The ledger row of migration 12, or null before it started. */
const ledgerRow = values(
  `SELECT json_build_object('state', state, 'progress', progress::text)::text AS value
   FROM core.platform_migration WHERE id = 12`
).pipe(
  Effect.flatMap(([text]) =>
    text === undefined ? Effect.succeed(null) : decodeLedgerRow(text)
  ),
  Effect.orDie
);

const count = (text: string) =>
  values(text).pipe(Effect.map(([value]) => Number(value)));

const usersWithIndividual = count(
  `SELECT count(individual)::text AS value FROM core."user"`
);

const users = count(`SELECT count(*)::text AS value FROM core."user"`);

const individuals = count(
  `SELECT count(*)::text AS value FROM core.individual`
);

const changes = count(`SELECT count(*)::text AS value FROM core.change`);

/** Whether a `std` command's backend waits for a row lock. */
const cliWaitsForLock = count(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = '${CLI_APPLICATION_NAME}'
     AND wait_event_type = 'Lock'`
).pipe(Effect.map((waiting) => waiting > 0));

const cliGone = count(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = '${CLI_APPLICATION_NAME}'`
).pipe(Effect.map((connected) => connected === 0));

describe("data-migration-interrupted", () => {
  it("stops the run inside the second batch", () => {
    assert.isAbove(OLD_USERS, 2 * DATA_BATCH_SIZE);
  });

  layer(schemaTestLayer(), { excludeTestServices: true, timeout: 180_000 })(
    (dbTest) => {
      dbTest.effect(
        "a killed data migration stays running, servers refuse to start, doctor reports it, and a rerun of std upgrade completes it once",
        () =>
          Effect.gen(function* interrupted() {
            const database = yield* TestDatabase;
            const { maintenance } = yield* Transactions;

            // The state after the sets of an upgrade loaded: core set
            // version 2, users without individuals, migration 12 pending.
            yield* loadSetDirectory(CORE_SET_DIRECTORY);
            yield* values(
              `INSERT INTO core."user" (id, class_id, version, created_at, created_by, updated_at, updated_by, name, login, active)
               SELECT uuidv7(), $1::uuid, 1, now(), $2::uuid, now(), $2::uuid, 'Old User ' || g, 'old-' || g, true
               FROM generate_series(1, ${OLD_USERS}) AS g
               RETURNING id::text AS value`,
              [USER_CLASS_ID, SYSTEM_USER_ID]
            );

            // A user in the second batch, locked until the run is killed.
            const [blocked] = yield* values(
              `SELECT id::text AS value FROM core."user" ORDER BY id OFFSET ${DATA_BATCH_SIZE + DATA_BATCH_SIZE / 2} LIMIT 1`
            );

            const locked = yield* Deferred.make<boolean>();
            const release = yield* Deferred.make<boolean>();

            const holder = yield* maintenance(
              Effect.gen(function* holdUser() {
                const sql = yield* SqlClient.SqlClient;

                yield* sql.unsafe(
                  `SELECT id FROM core."user" WHERE id = $1::uuid FOR UPDATE`,
                  [blocked ?? ""]
                );
                yield* Deferred.succeed(locked, true);
                yield* Deferred.await(release);
              })
            ).pipe(Effect.forkChild);

            yield* Deferred.await(locked);

            const upgrade = yield* runCli(database.url, ["upgrade"]).pipe(
              Effect.forkChild
            );

            yield* waitUntil(
              Effect.all([ledgerRow, cliWaitsForLock]).pipe(
                Effect.map(
                  ([row, waiting]) =>
                    row?.state === "running" && row.progress !== null && waiting
                )
              ),
              "60 seconds"
            );

            // SIGKILL, then let the dead process's backend see its socket
            // closed: its batch rolls back.
            yield* Fiber.interrupt(upgrade);
            yield* Deferred.succeed(release, true);
            yield* Fiber.join(holder);
            yield* waitUntil(cliGone, "30 seconds");

            const stopped = yield* ledgerRow;

            assert.strictEqual(stopped?.state, "running");
            assert.include(stopped?.progress ?? "", '"changed": 100');
            // The first batch committed, records and progress together.
            assert.strictEqual(yield* usersWithIndividual, DATA_BATCH_SIZE);
            assert.strictEqual(yield* individuals, DATA_BATCH_SIZE);

            // std serve refuses to start and names the migration.
            const serve = yield* startServe(database.url).pipe(Effect.flip);

            assert.strictEqual(serve._tag, "ServeNotListening");
            assert.include(
              serve._tag === "ServeNotListening" ? serve.log : "",
              "incomplete data migration 12 (user-individuals)"
            );

            // doctor exits 1 with dataMigrationIncomplete, naming it and its progress.
            const report = yield* runDoctor();

            const incomplete = report.findings.filter(
              (entry) => entry.code === "dataMigrationIncomplete"
            );

            assert.strictEqual(report.exitCode, 1);
            assert.lengthOf(incomplete, 1);
            assert.strictEqual(incomplete[0]?.subject, "12");
            assert.include(incomplete[0]?.message ?? "", "user-individuals");
            assert.include(incomplete[0]?.message ?? "", '"after"');

            // A rerun completes it.
            const rerun = yield* runCli(database.url, ["upgrade"]);

            assert.strictEqual(rerun.code, 0, rerun.output);
            assert.include(
              rerun.output,
              `Data migration 0012 user-individuals: resumed, ${OLD_USERS + 1 - DATA_BATCH_SIZE} records changed`
            );
            assert.strictEqual((yield* ledgerRow)?.state, "applied");
            assert.strictEqual((yield* runDoctor()).exitCode, 0);
            assert.strictEqual(yield* usersWithIndividual, yield* users);
            assert.strictEqual(yield* individuals, yield* users);

            // A second rerun changes nothing.
            const before = yield* changes;
            const again = yield* runCli(database.url, ["upgrade"]);

            assert.strictEqual(again.code, 0, again.output);
            assert.notInclude(again.output, "Data migration");
            assert.strictEqual(yield* changes, before);
            assert.strictEqual((yield* runDoctor()).exitCode, 0);
          })
      );
    }
  );
});
