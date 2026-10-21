/**
 * Recovery from interrupted schema changes (Contracts 1.5, 8.7): resume,
 * abandon and status.
 *
 * - **Resume.** Whoever holds `SCHEMA_KEY` may finish change sets left in
 *   `applying`: getting the lock proves their coordinator is gone, because
 *   a session lock is released when its backend ends (a build still running
 *   on a dead client's backend keeps it). Each unfinished step is probed:
 *   `done` is recorded, `partial` is cleaned up and rerun (an invalid index
 *   is dropped first), `not_started` runs; then `complete`. A step failing
 *   3 times moves the change set to `needs_attention`.
 *   `std schema resume <id>` does the same for a `needs_attention` change
 *   set after an admin fixed the cause.
 * - **Abandon.** `std schema abandon <id>` runs each unfinished step's
 *   abandon action (drop the index concurrently, drop the `NOT VALID`
 *   constraint under the lock budget) and then `complete`, which sets their
 *   enforcement `failed`, marks the change set `abandoned` and takes a
 *   revision. If the change set's own coordinator backend still holds
 *   `SCHEMA_KEY` (a build waiting on another session), abandon terminates
 *   that backend first: an operator decision, never taken automatically.
 * - **Status.** Open change sets, their steps and last errors, build
 *   progress from `pg_stat_progress_create_index`, what each running step
 *   waits for, and the `SCHEMA_KEY` holder's PID and client address.
 */
import type { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { ConfigCommitOptions } from "../sql/config-commit.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import { makeDedicatedConnection } from "../sql/dedicated.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { decodeRows } from "../sql/rows.ts";
import {
  completeChangeSet,
  openCoordinator,
  readSteps,
  runFollowUps,
} from "./coordinator.ts";
import type { FollowUpOutcome } from "./coordinator.ts";
import { dropConstraint } from "./ddl.ts";
import { RecoverySettings } from "./recovery-settings.ts";
import { SchemaChangeNotOpen } from "./schema-change-not-open.ts";
import { SchemaNeedsAttention } from "./schema-needs-attention.ts";
import { detailText, STEP_SPECS } from "./steps.ts";
import type { StepRow } from "./steps.ts";

/** `application_name` of the connection that tries to resume. */
export const RESUMER_APPLICATION_NAME = "std-resumer";

/** A change set that is not finished. */
export interface OpenChangeSet {
  readonly id: string;
  readonly state: "applying" | "needs_attention";
  readonly coordinatorPid: number | null;
  readonly error: string | null;
  readonly firstRevision: number | null;
}

const decodeOpen = decodeRows(
  Schema.Struct({
    coordinator_pid: Schema.NullOr(Schema.Int),
    error: Schema.NullOr(Schema.String),
    first_revision: Schema.NullOr(Schema.String),
    id: Schema.String,
    state: Schema.Literals(["applying", "needs_attention"]),
  })
);

/** Runs one statement on some connection. */
type Execute = (
  sql: string,
  params?: readonly unknown[]
) => Effect.Effect<readonly unknown[], DatabaseError>;

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

/**
 * The change sets in `applying` or `needs_attention`, oldest first: the one
 * reader of open change sets, for the resumer, `std schema`, coordinators
 * and `std upgrade` (which plans before migration 0002 may have run).
 *
 * @param execute - Runs one statement.
 * @returns The open change sets; none before the journal exists.
 */
export const openChangeSets = Effect.fn("Schema.openChangeSets")(
  function* openChangeSets(
    execute: Execute
  ): Effect.fn.Return<readonly OpenChangeSet[], DatabaseError> {
    const [journal] = yield* execute(
      "SELECT to_regclass('core.schema_change') IS NOT NULL AS present"
    ).pipe(Effect.flatMap(decodePresence));

    if (journal?.present !== true) {
      return [];
    }

    const rows = yield* execute(
      `SELECT id::text AS id, state, coordinator_pid, error, first_revision::text AS first_revision
       FROM core."schema_change" WHERE state IN ('applying', 'needs_attention')
       ORDER BY first_revision`
    ).pipe(Effect.flatMap(decodeOpen));

    return rows.map((row) => ({
      coordinatorPid: row.coordinator_pid,
      error: row.error,
      firstRevision:
        row.first_revision === null ? null : Number(row.first_revision),
      id: row.id,
      state: row.state,
    }));
  }
);

const takeOver = (connection: DedicatedConnection, changeSetId: string) =>
  connection
    .execute(
      `UPDATE core."schema_change"
     SET state = 'applying', coordinator_pid = $2::int4, error = NULL, version = version + 1, updated_at = now()
     WHERE id = $1::uuid`,
      [changeSetId, String(connection.processId)]
    )
    .pipe(
      Effect.andThen(
        connection.execute(
          `UPDATE core."schema_change_step"
         SET state = 'pending', version = version + 1, updated_at = now()
         WHERE change_id = $1::uuid AND state = 'failed'`,
          [changeSetId]
        )
      )
    );

/**
 * Resumes one change set on a connection that holds `SCHEMA_KEY`.
 *
 * @param connection - The connection holding `SCHEMA_KEY`.
 * @param changeSetId - A change set in `applying` or `needs_attention`.
 * @param options - Retry delays of the `complete` config commit.
 * @returns How it ended.
 */
export const resumeChangeSet = Effect.fn("Schema.resumeChangeSet")(
  function* resumeChangeSet(
    connection: DedicatedConnection,
    changeSetId: string,
    options?: ConfigCommitOptions
  ) {
    yield* takeOver(connection, changeSetId);
    yield* Effect.logInfo("Resuming schema change", { changeSetId });

    return yield* runFollowUps(connection, changeSetId, options);
  }
);

/**
 * Resumes every change set left in `applying`, on a connection that holds
 * `SCHEMA_KEY`. Change sets in `needs_attention` wait for an admin.
 *
 * @param connection - The connection holding `SCHEMA_KEY`.
 * @param options - Retry delays of the `complete` config commits.
 * @returns Each resumed change set and how it ended.
 */
export const resumeApplying = Effect.fn("Schema.resumeApplying")(
  function* resumeApplying(
    connection: DedicatedConnection,
    options?: ConfigCommitOptions
  ) {
    const open = yield* openChangeSets(connection.execute);

    const outcomes: {
      readonly id: string;
      readonly outcome: FollowUpOutcome;
    }[] = [];

    for (const changeSet of open) {
      if (changeSet.state === "applying") {
        outcomes.push({
          id: changeSet.id,
          outcome: yield* resumeChangeSet(connection, changeSet.id, options),
        });
      }
    }

    return outcomes;
  }
);

/**
 * What a new coordinator does once it holds `SCHEMA_KEY`, before its own
 * change set: finish interrupted ones, and refuse while one needs an
 * operator, because its stored statements name tables and columns as
 * they were.
 *
 * @param connection - The new coordinator's connection.
 * @param options - Retry delays.
 * @returns Fails with `SchemaNeedsAttention` naming the change set.
 */
export const settleOpenChangeSets = Effect.fn("Schema.settleOpenChangeSets")(
  function* settleOpenChangeSets(
    connection: DedicatedConnection,
    options?: ConfigCommitOptions
  ) {
    yield* resumeApplying(connection, options);

    const [waiting] = yield* openChangeSets(connection.execute);

    if (waiting !== undefined) {
      return yield* new SchemaNeedsAttention({
        changeSetId: waiting.id,
        error: waiting.error,
      });
    }

    return yield* Effect.void;
  }
);

/**
 * One resume attempt (Contracts 1.5): on a dedicated connection, try
 * `SCHEMA_KEY` without waiting; when it is free, resume every change set
 * in `applying` and release it again.
 *
 * @param options - Retry delays.
 * @returns The resumed change sets, empty when the lock was held or nothing
 *   was open.
 */
export const resumePass = Effect.fn("Schema.resumePass")(function* resumePass(
  options?: ConfigCommitOptions
) {
  return yield* Effect.scoped(
    Effect.gen(function* resumeWithLock() {
      const connection = yield* makeDedicatedConnection({
        applicationName: RESUMER_APPLICATION_NAME,
      });

      if (!(yield* connection.tryAdvisoryLock(SCHEMA_KEY))) {
        return [];
      }

      yield* Effect.addFinalizer(() =>
        Effect.ignore(connection.advisoryUnlock(SCHEMA_KEY))
      );

      return yield* resumeApplying(connection, options);
    })
  );
});

/**
 * The resumer of a server process: one resume attempt at startup and then
 * one every `resumeInterval` (30 s), each logging what it resumed. A failed
 * attempt is logged; the next one tries again.
 */
export const SchemaResumer: Layer.Layer<
  never,
  never,
  DatabaseConfig | PgClient.PgClient | SqlClient.SqlClient
> = Layer.effectDiscard(
  Effect.gen(function* startResumer() {
    const settings = yield* RecoverySettings;

    const pass = resumePass().pipe(
      Effect.tap((resumed) =>
        resumed.length === 0
          ? Effect.void
          : Effect.logInfo("Resumed schema changes", {
              changeSets: resumed.map((entry) => entry.id),
            })
      ),
      Effect.tapError((failure) =>
        Effect.logWarning("Schema change resume attempt failed", failure)
      ),
      Effect.ignore
    );

    yield* Effect.forkScoped(
      pass.pipe(Effect.repeat(Schedule.spaced(settings.resumeInterval)))
    );
  })
);

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

const HOLDER_QUERY = `SELECT l.pid FROM pg_locks l
  WHERE l.locktype = 'advisory' AND l.granted
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 1`;

const schemaKeyParams = [
  String(advisoryClassId(SCHEMA_KEY)),
  String(advisoryObjectId(SCHEMA_KEY)),
];

/**
 * The backends holding `SCHEMA_KEY`.
 *
 * @param execute - Runs one statement.
 * @returns Their PIDs.
 */
export const schemaKeyHolders = (
  execute: Execute
): Effect.Effect<readonly number[], DatabaseError> =>
  execute(HOLDER_QUERY, schemaKeyParams).pipe(
    Effect.flatMap(decodePid),
    Effect.map((rows) => rows.map((row) => row.pid))
  );

const ABANDON_LOCK_WAIT = Duration.seconds(60);

const decodeTerminated = decodeRows(
  Schema.Struct({ pid: Schema.Int, terminated: Schema.Boolean })
);

/**
 * Terminates the backend that is running a step of this change set right
 * now, and only that: in one statement, the change set must still be open,
 * the step `running` with that backend PID, the backend the same one that
 * started the step (its `backend_start` is not later than the step's
 * `started_at`, so a reused PID never matches), and the backend must hold
 * `SCHEMA_KEY`. A PID the journal merely remembers is never enough.
 */
const TERMINATE_OWN_BACKEND = `SELECT a.pid, pg_terminate_backend(a.pid) AS terminated
  FROM core."schema_change_step" s
  JOIN core."schema_change" c ON c.id = s.change_id AND c.state IN ('applying', 'needs_attention')
  JOIN pg_stat_activity a ON a.pid = s.backend_pid AND a.backend_start <= s.started_at
  JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'advisory' AND l.granted
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.classid = $2::oid AND l.objid = $3::oid AND l.objsubid = 1
  WHERE s.change_id = $1::uuid AND s.state = 'running'`;

/**
 * Fails unless the change set is `applying` or `needs_attention`.
 *
 * @param execute - Runs one statement.
 * @param changeSetId - The change set.
 * @returns Fails with `SchemaChangeNotOpen`.
 */
const requireOpen = Effect.fn("Schema.requireOpen")(function* requireOpen(
  execute: Execute,
  changeSetId: string
) {
  const open = yield* openChangeSets(execute);

  if (!open.some((entry) => entry.id === changeSetId)) {
    return yield* new SchemaChangeNotOpen({ changeSetId });
  }

  return yield* Effect.void;
});

/**
 * Takes `SCHEMA_KEY` for an abandon. The change set must still be open,
 * checked before anything else. If the lock is held by the backend that
 * is running one of this change set's steps right now (a build waiting on
 * another session, or one whose client died), that backend is terminated,
 * which ends the build and releases the lock; ownership is re-checked in
 * the statement that signals. Any other holder means another schema change
 * runs: `SchemaBusy`.
 *
 * @param changeSetId - The change set to abandon.
 * @returns A connection holding `SCHEMA_KEY`, closed with the scope.
 */
const lockForAbandon = Effect.fn("Schema.lockForAbandon")(
  function* lockForAbandon(changeSetId: string) {
    const sql = yield* SqlClient.SqlClient;

    const execute: Execute = (text, params = []) =>
      hygienic(sql.unsafe(text, params));

    yield* requireOpen(execute, changeSetId);

    const first = yield* Effect.result(openCoordinator);

    if (first._tag === "Success") {
      return first.success;
    }

    if (first.failure._tag !== "SchemaBusy") {
      return yield* first.failure;
    }

    const terminated = yield* execute(TERMINATE_OWN_BACKEND, [
      changeSetId,
      ...schemaKeyParams,
    ]).pipe(Effect.flatMap(decodeTerminated));

    if (!terminated.some((row) => row.terminated)) {
      return yield* first.failure;
    }

    yield* Effect.logWarning("Terminated the change set's own backend", {
      changeSetId,
      pids: terminated.map((row) => row.pid),
    });

    return yield* openCoordinator.pipe(
      Effect.retry(
        Schedule.spaced(Duration.millis(100)).pipe(
          Schedule.upTo({ times: Duration.toMillis(ABANDON_LOCK_WAIT) / 100 })
        )
      )
    );
  }
);

const constraintDropOf = (step: StepRow) =>
  dropConstraint(
    detailText(step, "table"),
    detailText(step, "constraint"),
    detailText(step, "referencedTable") || null
  );

/** What an abandon did. */
export interface AbandonOutcome {
  readonly changeSetId: string;
  /** The revision `complete` took. */
  readonly revision: number;
  /** The steps whose abandon action ran. */
  readonly abandonedSteps: readonly number[];
}

/**
 * Abandons a change set (Contracts 1.5, 8.7).
 *
 * @param changeSetId - A change set in `applying` or `needs_attention`.
 * @param options - Retry delays of the `complete` config commit.
 * @returns What was abandoned.
 */
export const abandonChangeSet = Effect.fn("Schema.abandonChangeSet")(
  function* abandonChangeSet(
    changeSetId: string,
    options?: ConfigCommitOptions
  ) {
    const connection = yield* lockForAbandon(changeSetId);
    const open = yield* openChangeSets(connection.execute);

    if (!open.some((entry) => entry.id === changeSetId)) {
      return yield* new SchemaChangeNotOpen({ changeSetId });
    }

    const steps = yield* readSteps(connection.execute, changeSetId);

    const unfinished = steps.filter(
      (step) => step.state !== "done" && step.kind !== "complete"
    );

    yield* connection.execute("SET lock_timeout = 0");
    yield* connection.execute("SET statement_timeout = 0");

    // Index steps are undone here, concurrently and outside any
    // transaction: an unfinished build's index is dropped, an unfinished
    // drop is finished. Constraint drops run inside `complete` below;
    // `validate_override` has nothing physical to undo.
    for (const step of unfinished) {
      if (
        step.kind === "create_index_concurrently" ||
        step.kind === "drop_index_concurrently"
      ) {
        yield* STEP_SPECS[step.kind].abandon(connection, step);
      }

      yield* connection.execute(
        `UPDATE core."schema_change_step"
         SET state = 'failed', last_error = coalesce(last_error, '') || ' (abandoned)',
             finished_at = clock_timestamp(), version = version + 1, updated_at = now()
         WHERE id = $1::uuid`,
        [step.id]
      );
    }

    yield* connection.execute("SET lock_timeout = DEFAULT");
    yield* connection.execute("SET statement_timeout = DEFAULT");

    const drops = unfinished.flatMap((step) =>
      step.kind === "validate_constraint" ? [constraintDropOf(step)] : []
    );

    const committed = yield* connection.transactions.configCommit(
      completeChangeSet(changeSetId, "abandoned", drops),
      options
    );

    return {
      abandonedSteps: unfinished.map((step) => step.ordinal),
      changeSetId,
      revision: committed.revision,
    } satisfies AbandonOutcome;
  },
  Effect.scoped
);

/**
 * Resumes one change set on request (`std schema resume <id>`): takes
 * `SCHEMA_KEY` (`SchemaBusy` if a coordinator still runs) and runs its
 * unfinished steps, probing each first.
 *
 * @param changeSetId - A change set in `applying` or `needs_attention`.
 * @param options - Retry delays.
 * @returns How it ended.
 */
export const resumeOnRequest = Effect.fn("Schema.resumeOnRequest")(
  function* resumeOnRequest(
    changeSetId: string,
    options?: ConfigCommitOptions
  ) {
    const connection = yield* openCoordinator;
    const open = yield* openChangeSets(connection.execute);

    if (!open.some((entry) => entry.id === changeSetId)) {
      return yield* new SchemaChangeNotOpen({ changeSetId });
    }

    return yield* resumeChangeSet(connection, changeSetId, options);
  },
  Effect.scoped
);
