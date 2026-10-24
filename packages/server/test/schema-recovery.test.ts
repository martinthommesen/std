/**
 * Recovery from interrupted schema changes (Contracts 1.5, 8.7): the
 * watchdog reports a build blocked by an idle-in-transaction session and
 * cancels nothing; a duplicate inserted during a unique build leaves
 * `needs_attention`, which refuses further DDL until `abandon` drops the
 * invalid index or `resume` finishes it after the cause is fixed; the
 * periodic resumer finishes a change set left `applying`; `std schema`
 * runs as a command.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { generatedName } from "@std/definitions/ids";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  RecoverySettings,
  StepBoundary,
} from "../src/schema/recovery-settings.ts";
import {
  abandonChangeSet,
  resumeOnRequest,
  SchemaResumer,
} from "../src/schema/recovery.ts";
import { schemaStatus } from "../src/schema/status.ts";
import { catalogDrift } from "./catalog-drift.ts";
import { runCli } from "./cli-support.ts";
import {
  addField,
  addIndex,
  change,
  changeSetState,
  createClass,
  currentRevision,
  insertRecords,
  interruptAt,
  insertRecordsSql,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const FAST_WATCHDOG = {
  resumeInterval: Duration.millis(200),
  watchdogAfter: Duration.millis(500),
  watchdogPoll: Duration.millis(100),
};

const indexValidity = (schema: string, name: string) =>
  values(
    `SELECT i.indisvalid::text AS value FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  ).pipe(Effect.map(([valid]) => valid ?? "absent"));

const applyingChangeSet = values(
  `SELECT id::text AS value FROM core."schema_change" WHERE state IN ('applying', 'needs_attention')`
).pipe(Effect.map(([id]) => id ?? ""));

/**
 * A table of stamps with distinct codes, and an open transaction on another
 * session that inserts a duplicate code: the unique build waits for it,
 * then meets the duplicate once it commits.
 * @param name - The table name.
 * @returns The class, the field, the blocking session and the change set fiber.
 */
const duplicateDuringBuild = (name: string) =>
  Effect.gen(function* startBuild() {
    const stamp = createClass(name);
    const code = addField(stamp.id, "code", { kind: "text" });
    const table = `"site"."${name}"`;

    yield* change([stamp.op, code.op]);
    yield* insertRecords([table], stamp.id, 5, { code: "'c' || g" });

    const database = yield* TestDatabase;
    const writer = yield* database.session(`${name}-writer`);

    yield* writer.query("BEGIN");
    yield* writer.query(
      insertRecordsSql([table], stamp.id, 1, { code: "'c1'" })
    );

    const unique = addIndex(stamp.id, [code.id], true);
    const build = yield* Effect.forkChild(change([unique.op]));

    yield* waitUntil(
      values(
        `SELECT count(*)::text AS value FROM pg_stat_progress_create_index p
         JOIN pg_stat_activity a ON a.pid = p.pid WHERE a.datname = current_database()`
      ).pipe(Effect.map(([count]) => count !== "0"))
    );
    yield* writer.query("COMMIT");

    const result = yield* Fiber.join(build);

    return { code, result, stamp, table, unique };
  });

describe("schema-recovery", () => {
  it("the watchdog reports after 10 minutes by default", () => {
    assert.strictEqual(
      Duration.toMinutes(RecoverySettings.defaultValue().watchdogAfter),
      10
    );
    assert.strictEqual(
      Duration.toSeconds(RecoverySettings.defaultValue().resumeInterval),
      30
    );
  });

  layer(
    Layer.effectDiscard(loadCoreAndAcme).pipe(
      Layer.provideMerge(schemaTestLayer({ maxConnections: 12 }))
    ),
    {
      excludeTestServices: true,
      timeout: 180_000,
    }
  )((dbTest) => {
    dbTest.effect(
      "an index build blocked by an idle-in-transaction session is reported by the watchdog and not cancelled",
      () =>
        Effect.scoped(
          Effect.gen(function* watchdog() {
            const crate = createClass("crate_w");
            const size = addField(crate.id, "size", { kind: "integer" });

            yield* change([crate.op, size.op]);
            yield* insertRecords(['"site"."crate_w"'], crate.id, 20, {
              size: "g",
            });

            const database = yield* TestDatabase;
            const idle = yield* database.session("idle-writer");

            const blocker = idle.processId;

            yield* idle.query("BEGIN");
            yield* idle.query(
              insertRecordsSql(['"site"."crate_w"'], crate.id, 1, { size: "0" })
            );

            const index = addIndex(crate.id, [size.id], false);

            const build = yield* Effect.forkChild(
              change([index.op]).pipe(
                Effect.provideService(RecoverySettings, FAST_WATCHDOG)
              )
            );

            const reported = values(
              `SELECT coalesce(last_error, '') AS value FROM core."schema_change_step"
               WHERE target_id = $1::uuid`,
              [index.id]
            ).pipe(
              Effect.map(([error]) =>
                (error ?? "").includes(`for PIDs ${blocker}`)
              )
            );

            yield* waitUntil(reported);

            const status = yield* schemaStatus();
            const [open] = status.changeSets;

            const running = open?.steps.find(
              (step) => step.state === "running"
            );

            assert.strictEqual(open?.state, "applying");
            assert.include(running?.waitingFor ?? [], blocker);
            assert.include(running?.lastError ?? "", "Watchdog");
            assert.isNotNull(running?.progress);
            assert.lengthOf(status.holders, 1);
            assert.strictEqual(status.holders[0]?.pid, open?.coordinatorPid);

            // Nothing was cancelled: the blocker is alive and its commit
            // lets the build finish.
            yield* idle.query("COMMIT");

            const result = yield* Fiber.join(build);

            assert.strictEqual(result.state, "completed");
            assert.strictEqual(
              yield* indexValidity("site", generatedName("ix", index.id)),
              "true"
            );
          })
        )
    );

    dbTest.effect(
      "a duplicate inserted during a unique build leaves needs_attention; abandon drops the invalid index",
      () =>
        Effect.scoped(
          Effect.gen(function* abandonBuild() {
            const built = yield* duplicateDuringBuild("stamp_a");
            const id = built.result.changeSetId ?? "";
            const indexName = generatedName("ix", built.unique.id);

            assert.strictEqual(built.result.state, "needs_attention");
            assert.strictEqual(yield* changeSetState(id), "needs_attention");
            assert.strictEqual(
              yield* indexValidity("site", indexName),
              "false"
            );

            // DDL waits for an operator; a label change does not.
            const blocked = yield* Effect.flip(
              change([addField(built.stamp.id, "extra", { kind: "text" }).op])
            );

            assert.strictEqual(blocked._tag, "SchemaNeedsAttention");

            const relabel = yield* change([
              {
                changes: { label: "Code" },
                id: built.code.id,
                op: "update",
                version: 1,
              },
            ]);

            assert.strictEqual(relabel.state, "completed");

            const status = yield* schemaStatus();

            assert.strictEqual(status.changeSets[0]?.state, "needs_attention");
            assert.include(status.changeSets[0]?.error ?? "", "failed 3 times");

            const revision = yield* currentRevision;
            const abandoned = yield* abandonChangeSet(id);

            assert.strictEqual(abandoned.revision, revision + 1);
            assert.strictEqual(yield* changeSetState(id), "abandoned");
            assert.strictEqual(
              yield* indexValidity("site", indexName),
              "absent"
            );
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).getKind(
                "index",
                built.unique.id
              )?.enforcement,
              "failed"
            );
            assert.lengthOf((yield* schemaStatus()).changeSets, 0);
            assert.deepStrictEqual(yield* catalogDrift, []);

            // DDL works again.
            const extra = yield* change([
              addField(built.stamp.id, "extra", { kind: "text" }).op,
            ]);

            assert.strictEqual(extra.state, "completed");
          })
        )
    );

    dbTest.effect(
      "after the duplicate is removed, resume completes the unique build",
      () =>
        Effect.scoped(
          Effect.gen(function* resumeBuild() {
            const built = yield* duplicateDuringBuild("stamp_r");
            const id = built.result.changeSetId ?? "";

            assert.strictEqual(built.result.state, "needs_attention");

            yield* values(
              `DELETE FROM ${built.table} WHERE id IN (SELECT id FROM ${built.table} WHERE code = 'c1' ORDER BY id DESC LIMIT 1) RETURNING id::text AS value`
            );

            const resumed = yield* resumeOnRequest(id);

            assert.strictEqual(resumed.state, "completed");
            assert.strictEqual(yield* changeSetState(id), "completed");
            assert.strictEqual(
              yield* indexValidity(
                "site",
                generatedName("ix", built.unique.id)
              ),
              "true"
            );
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).getKind(
                "index",
                built.unique.id
              )?.enforcement,
              "enforced"
            );
            assert.deepStrictEqual(yield* catalogDrift, []);
          })
        )
    );

    dbTest.effect(
      "the resumer of a process finishes a change set its coordinator left applying",
      () =>
        Effect.gen(function* resumer() {
          const bale = createClass("bale");
          const weight = addField(bale.id, "weight", { kind: "integer" });

          yield* change([bale.op, weight.op]);
          yield* insertRecords(['"site"."bale"'], bale.id, 10, { weight: "g" });

          const index = addIndex(bale.id, [weight.id], false);

          // The coordinator stops right after its main commit, as if its
          // process died there: its scope closes, which releases SCHEMA_KEY.
          const stopped = yield* Effect.exit(
            change([index.op]).pipe(interruptAt("committed"))
          );

          assert.isTrue(stopped._tag === "Failure");

          const id = yield* applyingChangeSet;

          assert.strictEqual(yield* changeSetState(id), "applying");

          yield* Effect.scoped(
            Layer.build(SchemaResumer).pipe(
              Effect.andThen(
                waitUntil(
                  changeSetState(id).pipe(
                    Effect.map((state) => state === "completed")
                  )
                )
              ),
              Effect.provideService(RecoverySettings, FAST_WATCHDOG)
            )
          );

          assert.strictEqual(
            yield* indexValidity("site", generatedName("ix", index.id)),
            "true"
          );
        })
    );

    dbTest.effect(
      "abandon of a change set another coordinator finished never terminates that coordinator",
      () =>
        Effect.scoped(
          Effect.gen(function* abandonFinished() {
            const first = createClass("first_a");
            const second = createClass("second_b");
            const a = addField(first.id, "a", { kind: "integer" });
            const b = addField(second.id, "b", { kind: "integer" });

            yield* change([first.op, second.op, a.op, b.op]);
            yield* insertRecords(['"site"."first_a"'], first.id, 5, { a: "g" });
            yield* insertRecords(['"site"."second_b"'], second.id, 5, {
              b: "g",
            });

            // Change set A stops right after its main commit.
            yield* Effect.exit(
              change([addIndex(first.id, [a.id], false).op]).pipe(
                interruptAt("committed")
              )
            );

            const changeSetA = yield* applyingChangeSet;

            // B's coordinator resumes and completes A on its connection,
            // commits its own main transaction, and then waits in its build
            // for a writer that starts only after that commit.
            const committed = yield* Deferred.make<boolean>();
            const proceed = yield* Deferred.make<boolean>();

            const changeSetB = yield* Effect.forkChild(
              change([addIndex(second.id, [b.id], false).op]).pipe(
                Effect.provideService(StepBoundary, (label) =>
                  label === "committed"
                    ? Deferred.succeed(committed, true).pipe(
                        Effect.andThen(Deferred.await(proceed)),
                        Effect.asVoid
                      )
                    : Effect.void
                )
              )
            );

            yield* Deferred.await(committed);
            assert.strictEqual(yield* changeSetState(changeSetA), "completed");

            const database = yield* TestDatabase;
            const writer = yield* database.session("second-writer");

            yield* writer.query("BEGIN");
            yield* writer.query(
              insertRecordsSql(['"site"."second_b"'], second.id, 1, { b: "0" })
            );
            yield* Deferred.succeed(proceed, true);
            yield* waitUntil(
              values(
                `SELECT count(*)::text AS value FROM pg_stat_progress_create_index p
                 JOIN pg_stat_activity a ON a.pid = p.pid WHERE a.datname = current_database()`
              ).pipe(Effect.map(([count]) => count !== "0"))
            );

            const [holder] = (yield* schemaStatus()).holders;

            // A's steps remember B's backend PID; abandon must not use it.
            const refused = yield* Effect.flip(abandonChangeSet(changeSetA));

            assert.strictEqual(refused._tag, "SchemaChangeNotOpen");
            assert.strictEqual(
              (yield* schemaStatus()).holders[0]?.pid,
              holder?.pid
            );

            yield* writer.query("COMMIT");

            const result = yield* Fiber.join(changeSetB);

            assert.strictEqual(result.state, "completed");
          })
        )
    );

    dbTest.effect(
      "abandoning an interrupted drop of a unique index finishes the drop",
      () =>
        Effect.gen(function* abandonDrop() {
          const token = createClass("token_d");
          const value = addField(token.id, "value", { kind: "integer" });
          const unique = addIndex(token.id, [value.id], true);

          yield* change([token.op, value.op, unique.op]);
          yield* insertRecords(['"site"."token_d"'], token.id, 3, {
            value: "g",
          });

          yield* Effect.exit(
            change([{ id: unique.id, op: "delete", version: 1 }]).pipe(
              interruptAt("before:1:drop_index_concurrently")
            )
          );

          const id = yield* applyingChangeSet;
          const indexName = generatedName("ix", unique.id);

          assert.strictEqual(yield* indexValidity("site", indexName), "true");

          yield* abandonChangeSet(id);

          assert.strictEqual(yield* changeSetState(id), "abandoned");
          assert.strictEqual(yield* indexValidity("site", indexName), "absent");

          // Duplicates are accepted again: nothing enforces the dropped index.
          yield* insertRecords(['"site"."token_d"'], token.id, 1, {
            value: "1",
          });
          assert.deepStrictEqual(yield* catalogDrift, []);
        })
    );

    dbTest.effect("std schema status and abandon run as commands", () =>
      Effect.gen(function* commands() {
        const database = yield* TestDatabase;

        const status = yield* runCli(database.url, [
          "schema",
          "status",
          "--json",
        ]);

        assert.strictEqual(status.code, 0, status.output);
        assert.deepStrictEqual(JSON.parse(status.output), {
          changeSets: [],
          holders: [],
        });

        const text = yield* runCli(database.url, ["schema", "status"]);

        assert.include(text.output, "No open change sets.");

        const missing = yield* runCli(database.url, [
          "schema",
          "abandon",
          "00000000-0000-4000-8000-000000000000",
        ]);

        assert.strictEqual(missing.code, 1);
        assert.include(missing.output, "is not applying or needs_attention");

        const usage = yield* runCli(database.url, ["schema", "resume"]);

        assert.strictEqual(usage.code, 2);
      })
    );
  });
});
