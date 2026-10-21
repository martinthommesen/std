/**
 * The coordinator of a change set with DDL or a data preflight (Contracts
 * 1.4, 1.5): it holds `SCHEMA_KEY` with `pg_try_advisory_lock` on one
 * dedicated connection from the preflight through `complete`, runs the main
 * transaction on that connection, then runs the follow-up steps in order,
 * marking each `running` and `done` in autocommit, and finally the
 * `complete` step under `CONFIG_KEY`, which takes its own revision.
 *
 * A failing step is retried up to `STEP_ATTEMPTS` times; then the step is
 * `failed` and the change set `needs_attention`. While a step runs, the
 * watchdog (`watchdog.ts`) reports long waits on other sessions. Resume
 * and abandon (`recovery.ts`) run the same steps after the coordinator is
 * gone, probing each first.
 */
import type { PgClient } from "@effect/sql-pg";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { parseJson, stringifyJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schedule, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import { bumpRevision } from "../sql/config-commit.ts";
import type { ConfigCommitOptions } from "../sql/config-commit.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import { makeDedicatedConnection } from "../sql/dedicated.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import type { DdlStatement } from "./ddl-forms.ts";
import { runDdl, takeTableLocks } from "./lock-budget.ts";
import { lockInventory } from "./plan.ts";
import { stepBoundary } from "./recovery-settings.ts";
import { SchemaBusy } from "./schema-busy.ts";
import { STEP_SPECS } from "./steps.ts";
import type { StepRow } from "./steps.ts";
import { watchStep } from "./watchdog.ts";

/** `application_name` of the coordinator's connection. */
export const COORDINATOR_APPLICATION_NAME = "std-coordinator";

/** `Retry-After` of `SchemaBusy`, in seconds [judgment]. */
export const SCHEMA_BUSY_RETRY_AFTER_SECONDS = 5;

/** How often a failing step runs before the change set needs attention. */
export const STEP_ATTEMPTS = 3;

const decodePids = decodeRows(Schema.Struct({ pid: Schema.Int }));

const decodeChangeIds = decodeRows(Schema.Struct({ id: Schema.String }));

const schemaBusy = Effect.fn("Schema.schemaBusy")(function* schemaBusy(
  connection: DedicatedConnection
): Effect.fn.Return<SchemaBusy, DatabaseError> {
  const pids = yield* connection
    .execute(
      `SELECT pid FROM pg_locks
         WHERE locktype = 'advisory' AND granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = $1::oid AND objid = $2::oid AND objsubid = 1`,
      [
        String(advisoryClassId(SCHEMA_KEY)),
        String(advisoryObjectId(SCHEMA_KEY)),
      ]
    )
    .pipe(Effect.flatMap(decodePids));

  const holderPids = pids.map((row) => row.pid);

  const [change] = yield* connection
    .execute(
      `SELECT id::text AS id FROM core."schema_change"
         WHERE state = 'applying' AND coordinator_pid = ANY($1::int4[])
         ORDER BY created_at DESC LIMIT 1`,
      [`{${holderPids.join(",")}}`]
    )
    .pipe(Effect.flatMap(decodeChangeIds));

  return new SchemaBusy({
    changeSetId: change?.id ?? null,
    holderPids,
    retryAfterSeconds: SCHEMA_BUSY_RETRY_AFTER_SECONDS,
  });
});

/**
 * Opens the coordinator's dedicated connection and takes `SCHEMA_KEY` with
 * `pg_try_advisory_lock`. The lock is released and the connection closed
 * with the scope.
 *
 * @returns The connection, or `SchemaBusy` naming the holder.
 */
export const openCoordinator: Effect.Effect<
  DedicatedConnection,
  SchemaBusy | DatabaseError,
  Scope.Scope | DatabaseConfig | PgClient.PgClient
> = Effect.gen(function* takeSchemaKey() {
  const connection = yield* makeDedicatedConnection({
    applicationName: COORDINATOR_APPLICATION_NAME,
  });

  if (!(yield* connection.tryAdvisoryLock(SCHEMA_KEY))) {
    return yield* schemaBusy(connection).pipe(Effect.flatMap(Effect.fail));
  }

  yield* Effect.addFinalizer(() =>
    Effect.ignore(connection.advisoryUnlock(SCHEMA_KEY))
  );

  return connection;
});

const decodeSteps = decodeRows(
  Schema.Struct({
    attempts: Schema.Int,
    details: Schema.String,
    id: Schema.String,
    kind: Schema.Literals([
      "validate_constraint",
      "validate_override",
      "create_index_concurrently",
      "drop_index_concurrently",
      "complete",
    ]),
    ordinal: Schema.Int,
    sql: Schema.NullOr(Schema.String),
    state: Schema.Literals(["pending", "running", "done", "failed"]),
    target_id: Schema.NullOr(Schema.String),
  })
);

const detailsOf = (text: string): JsonObject => {
  const parsed = parseJson(text);

  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : {};
};

const STEPS_QUERY = `SELECT id::text AS id, ordinal, kind, target_id::text AS target_id, sql, details, state, attempts
  FROM core."schema_change_step" WHERE change_id = $1::uuid ORDER BY ordinal`;

/**
 * The steps of a change set, in order.
 *
 * @param execute - Runs one statement.
 * @param changeSetId - The change set.
 * @returns Its steps.
 */
export const readSteps = <E, R>(
  execute: (
    sql: string,
    params: readonly unknown[]
  ) => Effect.Effect<readonly unknown[], E, R>,
  changeSetId: string
): Effect.Effect<readonly StepRow[], E, R> =>
  execute(STEPS_QUERY, [changeSetId]).pipe(
    Effect.flatMap(decodeSteps),
    Effect.map((rows) =>
      rows.map((row) => ({
        attempts: row.attempts,
        details: detailsOf(row.details),
        id: row.id,
        kind: row.kind,
        ordinal: row.ordinal,
        sql: row.sql,
        state: row.state,
        targetId: row.target_id,
      }))
    )
  );

const markRunning = (connection: DedicatedConnection, step: StepRow) =>
  connection.execute(
    `UPDATE core."schema_change_step"
     SET state = 'running', attempts = attempts + 1, backend_pid = pg_backend_pid(),
         started_at = clock_timestamp(), version = version + 1, updated_at = now()
     WHERE id = $1::uuid`,
    [step.id]
  );

const markDone = (
  connection: DedicatedConnection,
  step: StepRow,
  details: JsonObject
) =>
  connection.execute(
    `UPDATE core."schema_change_step"
     SET state = 'done', details = details || $2::jsonb, last_error = NULL,
         finished_at = clock_timestamp(), version = version + 1, updated_at = now()
     WHERE id = $1::uuid`,
    [step.id, stringifyJson(details)]
  );

const markFailedAttempt = (
  connection: DedicatedConnection,
  step: StepRow,
  error: string,
  final: boolean
) =>
  connection.execute(
    `UPDATE core."schema_change_step"
     SET state = $2::text, last_error = $3::text, version = version + 1, updated_at = now()
     WHERE id = $1::uuid`,
    [step.id, final ? "failed" : "running", error]
  );

const markNeedsAttention = (
  connection: DedicatedConnection,
  changeSetId: string,
  error: string
) =>
  connection.execute(
    `UPDATE core."schema_change"
     SET state = 'needs_attention', error = $2::text, version = version + 1, updated_at = now()
     WHERE id = $1::uuid`,
    [changeSetId, error]
  );

/** How the follow-up phase ended. */
export interface FollowUpOutcome {
  readonly state: "completed" | "needs_attention";
  /** The revision of `complete`, when the change set completed. */
  readonly revision: number | null;
  readonly error: string | null;
}

/** How the attempts of one step ended. */
type StepAttempts =
  | { readonly _tag: "Done"; readonly details: JsonObject }
  | { readonly _tag: "Failed"; readonly error: DatabaseError };

/**
 * Runs one step: records it `done` at once when its probe finds it done,
 * otherwise runs its action up to `STEP_ATTEMPTS` times. Only typed
 * database failures are retried and recorded; defects and interruption
 * propagate.
 *
 * @param connection - The coordinator's connection.
 * @param step - The step.
 * @returns A failure report after the last attempt, or null.
 */
const runStep = Effect.fn("Schema.runStep")(function* runStep(
  connection: DedicatedConnection,
  step: StepRow
): Effect.fn.Return<string | null, DatabaseError, SqlClient.SqlClient> {
  if (step.kind === "complete") {
    return null;
  }

  const spec = STEP_SPECS[step.kind];

  if ((yield* spec.probe(connection, step)) === "done") {
    yield* markDone(connection, step, {});

    return null;
  }

  const watchedAction = Effect.scoped(
    Effect.gen(function* watchedStepAction() {
      yield* Effect.forkScoped(watchStep(step.id, connection.processId));

      return yield* spec.action(connection, step);
    })
  );

  const attempt = markRunning(connection, step).pipe(
    Effect.andThen(watchedAction),
    Effect.tapError((failure) =>
      markFailedAttempt(connection, step, failure.message, false)
    )
  );

  const attempts = yield* attempt.pipe(
    Effect.map((details): StepAttempts => ({ _tag: "Done", details })),
    Effect.retryOrElse(Schedule.recurs(STEP_ATTEMPTS - 1), (failure) =>
      Effect.succeed<StepAttempts>({ _tag: "Failed", error: failure })
    )
  );

  if (attempts._tag === "Done") {
    yield* markDone(connection, step, attempts.details);

    return null;
  }

  const report = `Step ${step.ordinal} (${step.kind}) failed ${STEP_ATTEMPTS} times: ${attempts.error.message}`;

  yield* markFailedAttempt(connection, step, report, true);

  return report;
});

const ENFORCED_TABLES = new Map<string, string>([
  ["create_index_concurrently", "index"],
  ["validate_constraint", "field"],
  ["validate_override", "field_override"],
]);

/** How a change set ends: `complete` or the abandon actions plus `complete`. */
export type FinalState = "completed" | "abandoned";

/**
 * The `complete` step (Contracts 1.5): a config commit that sets the
 * enforcement of each step's target (`enforced` when the step is done and
 * its outcome holds, `failed` otherwise), marks `complete` done and the
 * change set `completed` or `abandoned`, and takes its own revision. An
 * abandon also drops the `NOT VALID` constraints of unfinished validation
 * steps here, under the lock budget.
 *
 * @param changeSetId - The change set.
 * @param final - Its final state.
 * @param drops - Constraint drops of an abandon.
 * @returns The new state.
 */
export const completeChangeSet = Effect.fn("Schema.completeChangeSet")(
  function* completeChangeSet(
    changeSetId: string,
    final: FinalState = "completed",
    drops: readonly DdlStatement[] = []
  ) {
    const sql = yield* SqlClient.SqlClient;
    const { revision } = yield* RequestRevision;

    if (drops.length > 0) {
      yield* runDdl(
        drops,
        yield* takeTableLocks(lockInventory(drops, new Set()))
      );
    }

    const steps = yield* readSteps(
      (text, params) => sql.unsafe(text, params),
      changeSetId
    );

    for (const step of steps) {
      const table = ENFORCED_TABLES.get(step.kind);

      if (table !== undefined && step.targetId !== null) {
        const outcome = step.details.outcome ?? "enforced";

        const enforcement =
          step.state === "done" && outcome === "enforced"
            ? "enforced"
            : "failed";

        yield* sql.unsafe(
          `UPDATE core."${table}" SET enforcement = $1::text WHERE id = $2::uuid`,
          [enforcement, step.targetId]
        );
      }
    }

    yield* sql`
      UPDATE core."schema_change_step"
      SET state = 'done', started_at = clock_timestamp(), finished_at = clock_timestamp(),
          attempts = attempts + 1, version = version + 1, updated_at = now()
      WHERE change_id = ${changeSetId}::uuid AND kind = 'complete'`;
    yield* sql`
      UPDATE core."schema_change"
      SET state = ${final}::text, last_revision = ${String(revision + 1)}::int8,
          completed_at = clock_timestamp(), version = version + 1, updated_at = now()
      WHERE id = ${changeSetId}::uuid`;

    return yield* bumpRevision(changeSetId);
  }
);

/**
 * Runs a change set's follow-up steps and its `complete` step on the
 * coordinator's connection.
 *
 * @param connection - The coordinator's connection, holding `SCHEMA_KEY`.
 * @param changeSetId - The change set, committed and `applying`.
 * @param options - Retry delays of the `complete` config commit.
 * @returns How the follow-up phase ended.
 */
export const runFollowUps = Effect.fn("Schema.runFollowUps")(
  function* runFollowUps(
    connection: DedicatedConnection,
    changeSetId: string,
    options?: ConfigCommitOptions
  ) {
    const steps = yield* readSteps(connection.execute, changeSetId);

    for (const step of steps) {
      if (step.state !== "done" && step.kind !== "complete") {
        yield* stepBoundary(`before:${step.ordinal}:${step.kind}`);
        const failure = yield* runStep(connection, step);

        if (failure === null) {
          yield* stepBoundary(`after:${step.ordinal}:${step.kind}`);
        } else {
          yield* markNeedsAttention(connection, changeSetId, failure);

          return {
            error: failure,
            revision: null,
            state: "needs_attention",
          } satisfies FollowUpOutcome;
        }
      }
    }

    yield* connection.execute("SET lock_timeout = DEFAULT");
    yield* connection.execute("SET statement_timeout = DEFAULT");
    yield* stepBoundary("before:complete");

    const completed = yield* connection.transactions.configCommit(
      completeChangeSet(changeSetId),
      options
    );

    return {
      error: null,
      revision: completed.revision,
      state: "completed",
    } satisfies FollowUpOutcome;
  }
);

/** The class ID written on journal rows. */
export const SCHEMA_CHANGE_CLASS_ID = PLATFORM_CLASS_IDS.schema_change;
