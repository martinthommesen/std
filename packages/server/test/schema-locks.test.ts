/**
 * Locks of change sets (Contracts 1.4, 1.5, 2.5): `SchemaLockTimeout`
 * naming the blocking session, the per-attempt lock budget, `SchemaBusy`
 * during a follow-up phase while config-only changes go on, and overrides
 * tightened over existing rows.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Ref,
  Schedule,
  Schema,
} from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { DDL_LOCK_BUDGET_MS } from "../src/schema/change-set.ts";
import {
  advisoryClassId,
  advisoryObjectId,
  CONFIG_KEY,
} from "../src/sql/locks.ts";
import { decodeRows } from "../src/sql/rows.ts";
import {
  ACME,
  addField,
  addIndex,
  addOverride,
  change,
  createClass,
  currentRevision,
  FAST_RETRIES,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ASSET = '"acme"."asset"';
const MONITOR = '"acme"."monitor"';

const POLL = Duration.millis(10);

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

/** Longest time one attempt may hold `CONFIG_KEY`: the budget plus slack. */
const MAX_HOLD_MS = 2200;

const columnExists = (table: string, column: string) =>
  values(
    `SELECT count(*)::text AS value FROM pg_attribute
     WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`,
    [table, column]
  ).pipe(Effect.map(([value]) => value === "1"));

/** Whether any session holds `CONFIG_KEY` exclusively, and which. */
const configKeyHolder = values(
  `SELECT pid::text AS value FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
     AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND classid = $1::oid AND objid = $2::oid`,
  [String(advisoryClassId(CONFIG_KEY)), String(advisoryObjectId(CONFIG_KEY))]
).pipe(Effect.map(([pid]) => pid));

/** What the `CONFIG_KEY` sampler shares with its test. */
interface HoldRecorder {
  /** How long each exclusive hold lasted, in milliseconds. */
  readonly spans: Ref.Ref<readonly number[]>;
  /** Set by the test once the change set has returned. */
  readonly done: Ref.Ref<boolean>;
  /** Completed by the sampler once it has seen the lock free after `done`. */
  readonly settled: Deferred.Deferred<boolean>;
}

/**
 * Samples `CONFIG_KEY` in Postgres every `POLL` and records how long each
 * exclusive hold lasted; completes `settled` once the test is done and the
 * last hold has been recorded. Sampling real time is the point here: the
 * hold durations are what the test measures.
 * @param recorder - The shared state.
 * @returns An effect that ends after `settled` completes.
 */
const recordHolds = (recorder: HoldRecorder) =>
  Effect.gen(function* sampleConfigKey() {
    let since: number | null = null;

    for (;;) {
      const holder = yield* configKeyHolder;
      const now = yield* Clock.currentTimeMillis;

      if (holder !== undefined && since === null) {
        since = now;
      } else if (holder === undefined && since !== null) {
        const started = since;

        yield* Ref.update(recorder.spans, (list) => [...list, now - started]);
        since = null;
      }

      if (holder === undefined && (yield* Ref.get(recorder.done))) {
        yield* Deferred.succeed(recorder.settled, true);

        return;
      }

      yield* Effect.sleep(POLL);
    }
  });

describe("schema-locks", () => {
  it("keeps the lock budget of Contracts 1.4", () => {
    assert.strictEqual(DDL_LOCK_BUDGET_MS, 2000);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an open transaction on the table makes the change set fail after 5 attempts, naming its PID",
      () =>
        Effect.scoped(
          Effect.gen(function* lockTimeout() {
            yield* loadCoreAndAcme;
            const database = yield* TestDatabase;
            const psql = yield* database.session("psql-like");

            const [pidRow] = yield* decodePid(
              (yield* psql.query("SELECT pg_backend_pid() AS pid")).rows
            );

            yield* psql.query("BEGIN");
            yield* psql.query(`SELECT count(*) FROM ${ASSET}`);
            const revision = yield* currentRevision;

            const failure = yield* Effect.flip(
              change(
                [addField(ACME.asset, "blocked", { kind: "integer" }).op],
                FAST_RETRIES
              )
            );

            yield* psql.query("ROLLBACK");
            assert.strictEqual(failure._tag, "SchemaLockTimeout");

            if (failure._tag === "SchemaLockTimeout") {
              assert.strictEqual(failure.attempts, 5);
              assert.include(
                failure.holders.map((holder) => holder.pid),
                pidRow?.pid
              );
            }

            assert.strictEqual(yield* currentRevision, revision);
            assert.isFalse(yield* columnExists(ASSET, "blocked"));
            assert.deepStrictEqual(
              yield* values(
                `SELECT count(*)::text AS value FROM core."field" WHERE name = 'blocked'`
              ),
              ["0"]
            );
          })
        )
    );

    dbTest.effect(
      "table locks released at staggered times never hold CONFIG_KEY past the 2 s budget",
      () =>
        Effect.scoped(
          Effect.gen(function* staggeredLocks() {
            yield* loadCoreAndAcme;
            const database = yield* TestDatabase;
            const first = yield* database.session("holder-1");
            const second = yield* database.session("holder-2");
            yield* first.query("BEGIN");
            yield* first.query(`LOCK TABLE ${ASSET} IN ROW EXCLUSIVE MODE`);
            yield* second.query("BEGIN");
            yield* second.query(`LOCK TABLE ${MONITOR} IN ROW EXCLUSIVE MODE`);

            const spans = yield* Ref.make<readonly number[]>([]);

            const recorder: HoldRecorder = {
              done: yield* Ref.make(false),
              settled: yield* Deferred.make<boolean>(),
              spans,
            };

            yield* Effect.forkChild(recordHolds(recorder));
            yield* Effect.forkChild(
              Effect.sleep("1500 millis").pipe(
                Effect.andThen(first.query("COMMIT"))
              )
            );
            yield* Effect.forkChild(
              Effect.sleep("3300 millis").pipe(
                Effect.andThen(second.query("COMMIT"))
              )
            );

            const dock = createClass("dock", {
              namespaceId: ACME.namespace,
              parentId: ACME.asset,
            });

            const monitorRef = addField(dock.id, "screen", {
              kind: "reference",
              targetClassId: ACME.monitor,
            });

            const result = yield* change(
              [dock.op, monitorRef.op],
              FAST_RETRIES
            );

            yield* Ref.set(recorder.done, true);
            yield* Deferred.await(recorder.settled).pipe(
              Effect.timeout(Duration.seconds(5))
            );

            const holds = yield* Ref.get(spans);

            yield* Effect.logInfo(`CONFIG_KEY holds: ${holds.join(", ")} ms`);
            assert.strictEqual(result.state, "completed");
            assert.isAtLeast(
              holds.length,
              2,
              "the first attempt timed out and was retried"
            );
            assert.isAtMost(
              Math.max(...holds),
              MAX_HOLD_MS,
              `holds: ${holds.join(", ")} ms`
            );
          })
        )
    );

    dbTest.effect(
      "a catalog lock the DDL takes internally is capped by what is left of the budget",
      () =>
        Effect.scoped(
          Effect.gen(function* internalLockWait() {
            yield* loadCoreAndAcme;
            const database = yield* TestDatabase;
            const tableHolder = yield* database.session("table-holder");
            const catalogHolder = yield* database.session("catalog-holder");

            // The explicit ACCESS EXCLUSIVE on the table waits 1.7 s; then
            // ADD COLUMN must insert into pg_attribute, which a session
            // holds in SHARE mode: a lock no LOCK TABLE can budget.
            yield* tableHolder.query("BEGIN");
            yield* tableHolder.query(
              `LOCK TABLE ${ASSET} IN ACCESS SHARE MODE`
            );
            yield* catalogHolder.query("BEGIN");
            yield* catalogHolder.query(
              "LOCK TABLE pg_catalog.pg_attribute IN SHARE MODE"
            );

            const spans = yield* Ref.make<readonly number[]>([]);

            const recorder: HoldRecorder = {
              done: yield* Ref.make(false),
              settled: yield* Deferred.make<boolean>(),
              spans,
            };

            yield* Effect.forkChild(recordHolds(recorder));
            yield* Effect.forkChild(
              Effect.sleep("1700 millis").pipe(
                Effect.andThen(tableHolder.query("COMMIT"))
              )
            );
            yield* Effect.forkChild(
              Effect.sleep("3000 millis").pipe(
                Effect.andThen(catalogHolder.query("COMMIT"))
              )
            );

            const result = yield* change(
              [addField(ACME.asset, "budgeted", { kind: "integer" }).op],
              FAST_RETRIES
            );

            yield* Ref.set(recorder.done, true);
            yield* Deferred.await(recorder.settled).pipe(
              Effect.timeout(Duration.seconds(5))
            );

            const holds = yield* Ref.get(spans);
            const [firstHold] = holds;

            yield* Effect.logInfo(`CONFIG_KEY holds: ${holds.join(", ")} ms`);
            assert.strictEqual(result.state, "completed");
            assert.isAtLeast(holds.length, 2, `holds: ${holds.join(", ")} ms`);
            assert.isAtLeast(
              firstHold ?? 0,
              1900,
              "the first attempt waited out its budget"
            );
            assert.isAtMost(
              firstHold ?? 0,
              MAX_HOLD_MS,
              "and stopped near the deadline"
            );
          })
        )
    );

    dbTest.effect(
      "a second DDL change set during a follow-up phase gets SchemaBusy; a label change succeeds",
      () =>
        Effect.scoped(
          Effect.gen(function* busy() {
            yield* loadCoreAndAcme;
            yield* insertRecords([ASSET], ACME.asset, 100, {
              name: "'asset ' || g",
              status: "'in_use'",
            });
            const database = yield* TestDatabase;
            const snapshotHolder = yield* database.session("old-snapshot");
            yield* snapshotHolder.query(
              "BEGIN ISOLATION LEVEL REPEATABLE READ"
            );
            yield* snapshotHolder.query(`SELECT count(*) FROM ${ASSET}`);

            const index = addIndex(ACME.asset, [ACME.status], false);
            const building = yield* Effect.forkChild(change([index.op]));

            // The step runs in another fiber's coordinator session; poll
            // its journal row until the build is running.
            yield* values(
              `SELECT s.state AS value FROM core."schema_change_step" s
               WHERE s.kind = 'create_index_concurrently' AND s.target_id = $1::uuid`,
              [index.id]
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced(POLL),
                until: ([state]) => state === "running",
              }),
              Effect.timeout(Duration.seconds(10))
            );

            const [changeSetId] = yield* values(
              `SELECT change_id::text AS value FROM core."schema_change_step" WHERE target_id = $1::uuid`,
              [index.id]
            );

            const refused = yield* Effect.flip(
              change([addField(ACME.asset, "late", { kind: "integer" }).op])
            );

            assert.strictEqual(refused._tag, "SchemaBusy");

            if (refused._tag === "SchemaBusy") {
              assert.strictEqual(refused.changeSetId, changeSetId);
              assert.isAbove(refused.retryAfterSeconds, 0);
            }

            const [version] = yield* values(
              `SELECT version::text AS value FROM core."field" WHERE id = $1::uuid`,
              [ACME.status]
            );

            const relabel = yield* change([
              {
                changes: { label: "Condition" },
                id: ACME.status,
                op: "update",
                version: Number(version),
              },
            ]);

            assert.strictEqual(relabel.state, "completed");

            yield* snapshotHolder.query("COMMIT");
            const built = yield* Fiber.join(building);

            assert.strictEqual(built.state, "completed");
            assert.strictEqual(
              built.completeRevision,
              (built.revision ?? 0) + 2
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT enforcement AS value FROM core."index" WHERE id = $1::uuid`,
                [index.id]
              ),
              ["enforced"]
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT i.indisvalid::text AS value FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
               WHERE c.relname = 'std_ix_' || replace($1, '-', '')`,
                [index.id]
              ),
              ["true"]
            );
          })
        )
    );

    dbTest.effect(
      "tightening an override over violating rows is refused with the count and samples",
      () =>
        Effect.gen(function* overrideTightening() {
          yield* loadCoreAndAcme;

          const monitors = yield* insertRecords(
            [ASSET, MONITOR],
            ACME.monitor,
            25,
            {
              name: "'monitor ' || g",
            }
          );

          const revision = yield* currentRevision;

          const required = addOverride(ACME.monitor, ACME.purchasedOn, {
            required: true,
          });

          const refused = yield* Effect.flip(change([required.op]));

          assert.strictEqual(refused._tag, "ExistingDataViolates");

          if (refused._tag === "ExistingDataViolates") {
            assert.strictEqual(refused.count, 25);
            assert.strictEqual(refused.definitionId, required.id);
            assert.deepStrictEqual(
              refused.sampleIds,
              monitors.toSorted().slice(0, 20)
            );
          }

          assert.strictEqual(yield* currentRevision, revision);

          yield* values(
            `UPDATE ${ASSET} SET purchased_on = '2026-02-01' WHERE class_id = '${ACME.monitor}'
           RETURNING id::text AS value`
          );
          const accepted = yield* change([required.op]);

          assert.strictEqual(accepted.state, "completed");
          assert.strictEqual(accepted.completeRevision, revision + 2);
          assert.deepStrictEqual(
            yield* values(
              `SELECT enforcement AS value FROM core."field_override" WHERE id = $1::uuid`,
              [required.id]
            ),
            ["enforced"]
          );
        })
    );
  });
});
