/**
 * The Step 1 gate for interrupted schema changes (plan Step 1; Contracts
 * 1.5, 8.7): SIGKILL of the coordinator process at every step boundary,
 * and during a concurrent index build, always ends `completed` after
 * resume, with the catalog matching the definitions.
 *
 * The coordinator is a child process (`fixtures/coordinator-child.ts`)
 * applying one change set with four follow-up steps on populated tables:
 * `validate_constraint` (a reference FK added `NOT VALID`),
 * `validate_override` (a child class makes an inherited field required),
 * `create_index_concurrently` (a unique index) and
 * `drop_index_concurrently` (an existing index dropped), then `complete`.
 * The test kills it with SIGKILL, so the operating system closes its
 * sockets and Postgres is never told; then it resumes the way a server
 * process or `std upgrade` does (`resumePass`) and checks the outcome.
 *
 * After the resume, `std doctor` exits 0.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { Deferred, Effect, Schema } from "effect";
import type { Scope } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { COORDINATOR_APPLICATION_NAME } from "../src/schema/coordinator.ts";
import { resumePass } from "../src/schema/recovery.ts";
import { schemaStatus } from "../src/schema/status.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { catalogDrift } from "./catalog-drift.ts";
import {
  addField,
  addIndex,
  addOverride,
  change,
  createClass,
  insertRecords,
  insertRecordsSql,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const CHILD_SCRIPT = new URL("fixtures/coordinator-child.ts", import.meta.url)
  .pathname;

/** Every boundary the coordinator reports for a change set with four steps. */
const BOUNDARIES = [
  "committed",
  "before:1:validate_constraint",
  "after:1:validate_constraint",
  "before:2:validate_override",
  "after:2:validate_override",
  "before:3:create_index_concurrently",
  "after:3:create_index_concurrently",
  "before:4:drop_index_concurrently",
  "after:4:drop_index_concurrently",
  "before:complete",
] as const;

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

/** A populated hierarchy and the change set the coordinator will apply. */
interface Scenario {
  readonly table: string;
  readonly rootId: string;
  readonly uniqueIndexId: string;
  readonly droppedIndexId: string;
  readonly operations: readonly Operation[];
}

/**
 * Creates `site.<name>` (30 records), its child class (10 records), a
 * target table, and an index on `size`; returns the change set to apply.
 * @param name - The root table's name.
 * @returns The scenario.
 */
const scenario = (name: string) =>
  Effect.gen(function* createScenario() {
    const root = createClass(name);
    const code = addField(root.id, "code", { kind: "text" });
    const size = addField(root.id, "size", { kind: "integer" });
    const sizeIndex = addIndex(root.id, [size.id], false);
    const kid = createClass(`${name}_kid`, { parentId: root.id });
    const target = createClass(`${name}_target`);

    yield* change([root.op, code.op, size.op, sizeIndex.op, kid.op, target.op]);

    const table = `"site"."${name}"`;

    yield* insertRecords([table], root.id, 30, {
      code: "'k' || g",
      size: "g",
    });
    yield* insertRecords([table, `"site"."${name}_kid"`], kid.id, 10, {
      code: "'kid' || g",
      size: "g",
    });
    yield* insertRecords([`"site"."${name}_target"`], target.id, 3);

    const unique = addIndex(root.id, [code.id], true);

    const operations: readonly Operation[] = [
      addField(root.id, "buddy", {
        kind: "reference",
        targetClassId: target.id,
      }).op,
      addOverride(kid.id, size.id, { required: true }).op,
      unique.op,
      { id: sizeIndex.id, op: "delete", version: 1 },
    ];

    return {
      droppedIndexId: sizeIndex.id,
      operations,
      rootId: root.id,
      table,
      uniqueIndexId: unique.id,
    } satisfies Scenario;
  });

/** A running coordinator process. */
interface Coordinator {
  readonly child: ChildProcess;
  /** Completes once the child printed `PAUSED`. */
  readonly paused: Deferred.Deferred<string>;
}

/**
 * Starts the coordinator process; it is killed when the scope closes.
 * @param url - The test database.
 * @param operations - The change set.
 * @param pauseAt - The boundary to stop at, or `none`.
 * @param continueOnInput - Whether the process goes on after its pause once
 *   the test writes a line to its stdin.
 * @returns The process.
 */
const startCoordinator = (
  url: string,
  operations: readonly Operation[],
  pauseAt: string,
  continueOnInput = false
): Effect.Effect<Coordinator, never, Scope.Scope> =>
  Effect.gen(function* start() {
    const paused = yield* Deferred.make<string>();

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [CHILD_SCRIPT], {
          env: {
            ...process.env,
            STD_DATABASE_DIRECT_URL: url,
            STD_DATABASE_URL: url,
            STD_TEST_CONTINUE_ON_INPUT: continueOnInput ? "1" : "0",
            STD_TEST_OPERATIONS: JSON.stringify(operations),
            STD_TEST_PAUSE_AT: pauseAt,
          },
          stdio: ["pipe", "pipe", "inherit"],
        })
      ),
      (process) =>
        Effect.sync(() => {
          process.kill("SIGKILL");
        })
    );

    let output = "";

    child.stdout?.on("data", (chunk: Uint8Array) => {
      output += String(chunk);

      const match = /PAUSED (?<label>\S+)/u.exec(output);

      if (match?.groups?.label !== undefined) {
        Deferred.doneUnsafe(paused, Effect.succeed(match.groups.label));
      }
    });

    return { child, paused };
  });

/**
 * Kills the process with SIGKILL and waits until it is gone.
 * @param child - The process.
 * @returns Completes once it exited.
 */
const kill = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<string | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.signalCode));

      return;
    }

    child.once("exit", (_code, signal) => {
      resume(Effect.succeed(signal));
    });
    child.kill("SIGKILL");
  }).pipe(Effect.asVoid);

const schemaKeyFree = schemaStatus().pipe(
  Effect.map((status) => status.holders.length === 0)
);

const stateOf = (changeSetId: string) =>
  values(
    `SELECT state AS value FROM core."schema_change" WHERE id = $1::uuid`,
    [changeSetId]
  ).pipe(Effect.map(([state]) => state));

const openChangeSetId = values(
  `SELECT id::text AS value FROM core."schema_change" WHERE state = 'applying'`
).pipe(Effect.map(([id]) => id));

/**
 * Resumes as a server process or `std upgrade` does, then checks that the
 * change set completed and the catalog matches the definitions.
 * @param setup - The scenario.
 * @returns The effect.
 */
const assertRecovered = (setup: Scenario) =>
  Effect.gen(function* recover() {
    const changeSetId = yield* openChangeSetId;

    assert.isDefined(changeSetId, "the change set was left applying");

    const resumed = yield* resumePass();

    assert.deepStrictEqual(
      resumed.map((entry) => [entry.id, entry.outcome.state]),
      [[changeSetId, "completed"]]
    );
    assert.strictEqual(yield* stateOf(changeSetId ?? ""), "completed");

    const snapshot = yield* (yield* Catalog).refresh;

    assert.strictEqual(
      snapshot.getKind("index", setup.uniqueIndexId)?.enforcement,
      "enforced"
    );
    assert.strictEqual(
      snapshot.getKind("index", setup.droppedIndexId)?.state,
      "purged"
    );
    assert.deepStrictEqual(yield* catalogDrift, []);

    const doctor = yield* runDoctor();

    assert.deepStrictEqual(
      doctor.findings.filter((entry) => entry.severity !== "info"),
      []
    );
    assert.strictEqual(doctor.exitCode, 0);
  });

describe("schema-interrupted", () => {
  it("kills the coordinator at every one of the ten step boundaries", () => {
    assert.lengthOf(BOUNDARIES, 10);
  });

  layer(schemaTestLayer({ maxConnections: 8 }), {
    excludeTestServices: true,
    timeout: 600_000,
  })((dbTest) => {
    for (const [index, boundary] of BOUNDARIES.entries()) {
      dbTest.effect(
        `SIGKILL of the coordinator at ${boundary} ends completed after resume`,
        () =>
          Effect.scoped(
            Effect.gen(function* killAtBoundary() {
              yield* loadCoreAndAcme;

              const database = yield* TestDatabase;
              const setup = yield* scenario(`kill_${index}`);

              const coordinator = yield* startCoordinator(
                database.url,
                setup.operations,
                boundary
              );

              assert.strictEqual(
                yield* Deferred.await(coordinator.paused),
                boundary
              );
              yield* kill(coordinator.child);
              yield* waitUntil(schemaKeyFree);
              yield* assertRecovered(setup);
            })
          )
      );
    }

    dbTest.effect(
      "SIGKILL of the coordinator during a concurrent index build ends completed after resume",
      () =>
        Effect.scoped(
          Effect.gen(function* killDuringBuild() {
            yield* loadCoreAndAcme;

            const database = yield* TestDatabase;
            const setup = yield* scenario("kill_build");

            const coordinator = yield* startCoordinator(
              database.url,
              setup.operations,
              "before:3:create_index_concurrently",
              true
            );

            yield* Deferred.await(coordinator.paused);

            // An open writer, started after the main commit, keeps the build
            // waiting, so the kill lands while the backend is inside
            // CREATE INDEX CONCURRENTLY.
            const writer = yield* database.session("kill-build-writer");

            yield* writer.query("BEGIN");
            yield* writer.query(
              insertRecordsSql([setup.table], setup.rootId, 1, {
                code: "'late'",
                size: "99",
              })
            );
            coordinator.child.stdin?.write("go\n");

            const building = values(
              `SELECT p.pid::text AS value FROM pg_stat_progress_create_index p
               JOIN pg_stat_activity a ON a.pid = p.pid
               WHERE a.datname = current_database() AND a.application_name = $1`,
              [COORDINATOR_APPLICATION_NAME]
            );

            yield* waitUntil(
              building.pipe(Effect.map((pids) => pids.length > 0))
            );

            const [backend] = yield* building;

            yield* kill(coordinator.child);

            // The backend lives on and keeps SCHEMA_KEY: no resume can race it.
            const holders = (yield* schemaStatus()).holders.map((holder) =>
              String(holder.pid)
            );

            assert.deepStrictEqual(holders, [backend]);

            const [alive] = yield* decodePid(
              (yield* writer.query(
                "SELECT count(*)::int AS pid FROM pg_stat_activity WHERE pid = $1::int",
                [Number(backend)]
              )).rows
            );

            assert.strictEqual(alive?.pid, 1);
            assert.deepStrictEqual(yield* resumePass(), []);

            yield* writer.query("COMMIT");
            yield* waitUntil(schemaKeyFree);
            yield* assertRecovered(setup);
          })
        )
    );
  });
});
