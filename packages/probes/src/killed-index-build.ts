/**
 * Probe 2 (plan 0F; Contracts 1.5 "Resume", "Coordinator connection"): the
 * client of a `CREATE INDEX CONCURRENTLY` is killed mid-build.
 *
 * A child process (`index-build-child.ts`) plays the coordinator: on a
 * dedicated connection it takes `SCHEMA_KEY` with `pg_try_advisory_lock`
 * and starts the build. The probe kills the child process with SIGKILL, so
 * the operating system closes its socket; the backend is never signalled
 * (no `pg_terminate_backend`). It then checks, while the build goes on,
 * that the backend is alive and still holds `SCHEMA_KEY` (another session's
 * `pg_try_advisory_lock` fails), lets the build end, and reads the index's
 * `pg_index.indisvalid` and whether `SCHEMA_KEY` is free.
 *
 * Scenarios:
 *
 * - `writer`: an open writer transaction makes the build wait in its first
 *   phase, so the kill lands during a lock wait. The writer commits after
 *   `holdAfterKillMs`; with `duplicate` it first inserts a duplicate key, so
 *   a unique build fails and leaves an invalid index.
 * - `scan`: no writer; the kill lands while the build scans a large table.
 *
 * `checkInterval` sets `client_connection_check_interval` for the probe
 * database (`ALTER DATABASE ... SET`, so the child's new session gets it).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import type { DedicatedConnection } from "@std/server/sql/dedicated";
import {
  advisoryClassId,
  advisoryObjectId,
  SCHEMA_KEY,
} from "@std/server/sql/locks";
import { decodeRows } from "@std/server/sql/rows";
import { TestDatabase } from "@std/testing/test-database";
import { Duration, Effect, Schema } from "effect";
import type { Scope } from "effect";

import { now } from "./clock.ts";
import { INDEX_BUILD_APPLICATION_NAME } from "./index-build-names.ts";
import { pollFor, waitFor } from "./observe.ts";

/** One way of killing a build's client. */
export interface KilledBuildScenario {
  readonly label: string;
  /** What keeps the build busy when the client is killed. */
  readonly busy: "writer" | "scan";
  readonly unique: boolean;
  /** Insert a duplicate key from the writer before it commits (`writer` only). */
  readonly duplicate: boolean;
  /** `client_connection_check_interval`, for example `0` or `250ms`. */
  readonly checkInterval: string;
  /** Rows in the table. */
  readonly rows: number;
  /** How long the writer stays open after the kill (`writer` only). */
  readonly holdAfterKillMs: number;
}

/** The index's state in `pg_index`. */
export type IndexState = "missing" | "valid" | "invalid";

/** What one scenario observed. */
export interface KilledBuildResult {
  readonly scenario: KilledBuildScenario;
  /** `client_connection_check_interval` as a new session sees it. */
  readonly effectiveCheckInterval: string;
  /** Progress phase of the build when the client was killed. */
  readonly phaseAtKill: string;
  /** The backend was alive when the probe stopped watching after the kill. */
  readonly backendAliveAfterKill: boolean;
  /** `SCHEMA_KEY` was held by the build's backend then. */
  readonly lockHeldAfterKill: boolean;
  /** Another session's `pg_try_advisory_lock(SCHEMA_KEY)` failed then. */
  readonly tryLockRefusedAfterKill: boolean;
  /** Time from the kill until the backend exited. */
  readonly backendExitAfterKillMs: number;
  /**
   * Time from the writer's commit until the backend exited; negative when
   * it exited before the commit, `null` for scan scenarios.
   */
  readonly backendExitAfterReleaseMs: number | null;
  readonly indexState: IndexState;
  /** `pg_try_advisory_lock(SCHEMA_KEY)` succeeded once the backend was gone. */
  readonly lockFreeAfterEnd: boolean;
}

const CHILD_SCRIPT = fileURLToPath(
  new URL("index-build-child.ts", import.meta.url)
);

const INDEX_NAME = "probe_build_code";
const TABLE_NAME = "probe_build";
const ABSENT = -1;

const decodeBackend = decodeRows(
  Schema.Struct({
    phase: Schema.NullOr(Schema.String),
    pid: Schema.Int,
    wait_event_type: Schema.NullOr(Schema.String),
  })
);

const decodeHolder = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeIndex = decodeRows(
  Schema.Struct({ indisvalid: Schema.NullOr(Schema.Boolean) })
);

const decodeSetting = decodeRows(Schema.Struct({ setting: Schema.String }));

const BACKEND_QUERY = `
SELECT a.pid, a.wait_event_type, p.phase
FROM pg_stat_activity a
LEFT JOIN pg_stat_progress_create_index p ON p.pid = a.pid
WHERE a.datname = current_database() AND a.application_name = $1
  AND a.query ILIKE 'CREATE%INDEX CONCURRENTLY%'`;

const HOLDER_QUERY = `
SELECT pid FROM pg_locks
WHERE locktype = 'advisory' AND granted
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND classid = ${String(advisoryClassId(SCHEMA_KEY))}::oid
  AND objid = ${String(advisoryObjectId(SCHEMA_KEY))}::oid`;

const startChild = (
  url: string,
  statement: string
): Effect.Effect<ChildProcess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [CHILD_SCRIPT, statement], {
        env: { ...process.env, STD_DATABASE_URL: url },
        stdio: "ignore",
      })
    ),
    (child) =>
      Effect.sync(() => {
        child.kill("SIGKILL");
      })
  );

const killAndReap = (child: ChildProcess): Effect.Effect<string | null> =>
  Effect.callback<string | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.signalCode));

      return;
    }

    child.once("exit", (_code, signal) => {
      resume(Effect.succeed(signal));
    });
    child.kill("SIGKILL");
  });

/**
 * Observes the build's backend and `SCHEMA_KEY` through a separate
 * dedicated connection.
 * @param observer - The probe's own connection.
 * @returns Helpers that read the build's state.
 */
const watcher = (observer: DedicatedConnection) => {
  const backend = observer
    .execute(BACKEND_QUERY, [INDEX_BUILD_APPLICATION_NAME])
    .pipe(
      Effect.flatMap(decodeBackend),
      Effect.map(([row]) => row)
    );

  const holder = observer.execute(HOLDER_QUERY).pipe(
    Effect.flatMap(decodeHolder),
    Effect.map(([row]) => row?.pid ?? ABSENT)
  );

  const backendAlive = (pid: number) =>
    observer
      .execute("SELECT pid FROM pg_stat_activity WHERE pid = $1", [pid])
      .pipe(
        Effect.flatMap(decodeHolder),
        Effect.map((rows) => rows.length > 0)
      );

  const tryLock = observer
    .tryAdvisoryLock(SCHEMA_KEY)
    .pipe(
      Effect.tap((locked) =>
        locked ? observer.advisoryUnlock(SCHEMA_KEY) : Effect.void
      )
    );

  const indexState = observer
    .execute(
      "SELECT i.indisvalid FROM (SELECT to_regclass($1) AS oid) r LEFT JOIN pg_index i ON i.indexrelid = r.oid",
      [INDEX_NAME]
    )
    .pipe(
      Effect.flatMap(decodeIndex),
      Effect.map(([row]): IndexState => {
        if (row?.indisvalid === null || row?.indisvalid === undefined) {
          return "missing";
        }

        return row.indisvalid ? "valid" : "invalid";
      })
    );

  return { backend, backendAlive, holder, indexState, tryLock };
};

/**
 * Runs one scenario of probe 2 on the current database.
 * @param scenario - How the build is kept busy and killed.
 * @returns What happened.
 */
export const runKilledBuildScenario = Effect.fn("runKilledBuildScenario")(
  function* killedBuild(scenario: KilledBuildScenario) {
    const database = yield* TestDatabase;

    const observer = yield* makeDedicatedConnection({
      applicationName: "std-probe-build-observer",
    });

    const watch = watcher(observer);
    const { execute } = observer;
    const quotedName = `"${database.name}"`;

    yield* execute(
      `ALTER DATABASE ${quotedName} SET client_connection_check_interval = '${scenario.checkInterval}'`
    );

    const settingSession = yield* Effect.scoped(
      makeDedicatedConnection({ applicationName: "std-probe-setting" }).pipe(
        Effect.flatMap((session) =>
          session.execute(
            "SELECT current_setting('client_connection_check_interval') AS setting"
          )
        ),
        Effect.flatMap(decodeSetting)
      )
    );

    yield* execute(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
    yield* execute(
      `CREATE TABLE ${TABLE_NAME} (id int8 PRIMARY KEY, code int8 NOT NULL) WITH (autovacuum_enabled = false)`
    );
    yield* execute(
      `INSERT INTO ${TABLE_NAME} SELECT g, g FROM generate_series(1, $1::int8) AS g`,
      [String(scenario.rows)]
    );
    yield* execute(`VACUUM (ANALYZE) ${TABLE_NAME}`);

    const writer = yield* database.session("std-probe-build-writer");

    if (scenario.busy === "writer") {
      yield* writer.query("BEGIN");
      yield* writer.query(`INSERT INTO ${TABLE_NAME} VALUES (-1, -1)`);
    }

    const statement = `CREATE ${scenario.unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${INDEX_NAME} ON ${TABLE_NAME} (code)`;
    const child = yield* startChild(database.url, statement);

    let phaseAtKill = "";
    let pid = ABSENT;

    yield* waitFor(
      watch.backend.pipe(
        Effect.map((row) => {
          const ready =
            row !== undefined &&
            (scenario.busy === "writer"
              ? row.wait_event_type === "Lock"
              : (row.phase ?? "").startsWith("building index"));

          if (ready) {
            phaseAtKill = row.phase ?? "";
            ({ pid } = row);
          }

          return ready;
        })
      )
    );

    yield* killAndReap(child);
    const killedAt = yield* now;
    let exitedAt = Number.NaN;

    const noteExit = watch.backendAlive(pid).pipe(
      Effect.tap((alive) =>
        Effect.gen(function* recordExit() {
          if (!alive && Number.isNaN(exitedAt)) {
            exitedAt = yield* now;
          }
        })
      ),
      Effect.map((alive) => !alive)
    );

    let backendAliveAfterKill = true;
    let lockHeldAfterKill = true;
    let tryLockRefusedAfterKill = true;
    let releasedAt: number | null = null;

    if (scenario.busy === "writer") {
      // Watch for the hold time: the backend may notice the lost client.
      yield* pollFor(noteExit, Duration.millis(scenario.holdAfterKillMs));

      backendAliveAfterKill = !(yield* noteExit);
      lockHeldAfterKill = (yield* watch.holder) === pid;
      tryLockRefusedAfterKill = !(yield* watch.tryLock);

      if (scenario.duplicate) {
        yield* writer.query(`INSERT INTO ${TABLE_NAME} VALUES (-2, 1)`);
      }

      yield* writer.query("COMMIT");
      releasedAt = yield* now;
    } else {
      backendAliveAfterKill = !(yield* noteExit);
      lockHeldAfterKill = (yield* watch.holder) === pid;
      tryLockRefusedAfterKill = !(yield* watch.tryLock);
    }

    yield* waitFor(noteExit);

    const result: KilledBuildResult = {
      backendAliveAfterKill,
      backendExitAfterKillMs: exitedAt - killedAt,
      backendExitAfterReleaseMs:
        releasedAt === null ? null : exitedAt - releasedAt,
      effectiveCheckInterval: settingSession[0]?.setting ?? "",
      indexState: yield* watch.indexState,
      lockFreeAfterEnd: yield* watch.tryLock,
      lockHeldAfterKill,
      phaseAtKill,
      scenario,
      tryLockRefusedAfterKill,
    };

    yield* execute(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
    yield* execute(`DROP TABLE ${TABLE_NAME}`);
    yield* execute(
      `ALTER DATABASE ${quotedName} RESET client_connection_check_interval`
    );

    return result;
  }
);
