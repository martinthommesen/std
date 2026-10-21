/**
 * Applying a change set (Contracts 1.4): one admin request or one
 * definition-set load, applied in one main transaction, plus follow-up steps
 * and `complete` when its DDL needs them.
 *
 * 1. Load the current configuration, apply the operations in memory and
 *    validate (`DefinitionInvalid` before any lock). An operation list that
 *    changes nothing returns `unchanged`: no change set, no revision.
 * 2. Without DDL or a data preflight (labels, roles, access rules), only
 *    `CONFIG_KEY` is taken: the main transaction runs on the pool.
 * 3. Otherwise the coordinator takes `SCHEMA_KEY` on a dedicated connection
 *    (`SchemaBusy` if another change set holds it), checks which tables hold
 *    rows and counts violating rows (`ExistingDataViolates` with up to 20
 *    sample IDs), and checks every planned statement against the allowed DDL
 *    forms (`DdlRefused`), all before `CONFIG_KEY` and before any DDL.
 * 4. The main transaction (`configCommit`: `CONFIG_KEY` exclusive,
 *    `lock_timeout` 200 ms then 2 s, `statement_timeout` 15 s, retries,
 *    `SchemaLockTimeout`) loads the snapshot at the locked revision,
 *    re-applies and re-validates the operations, verifies platform tables,
 *    runs the DDL, writes definition rows, definition revisions, the
 *    dependency index and the journal, bumps the revision by exactly 1 and
 *    notifies `std_config`.
 * 5. Follow-up steps run in order on the coordinator's connection, then
 *    `complete` takes its own revision.
 */
import type { PgClient } from "@effect/sql-pg";
import { applyOperations } from "@std/definitions/apply";
import type { AppliedChangeSet } from "@std/definitions/apply";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import type { DefinitionInvalid } from "@std/definitions/problems";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Result, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import { installSessionRevocation } from "../auth/session-revocation.ts";
import { Catalog } from "../catalog/catalog.ts";
import { bumpRevision, MAIN_LOCK_TIMEOUT } from "../sql/config-commit.ts";
import type {
  ConfigCommitOptions,
  SchemaLockTimeout,
} from "../sql/config-commit.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { lockWaiting } from "../sql/statement-marks.ts";
import { Transactions } from "../sql/transactions.ts";
import { openCoordinator, runFollowUps } from "./coordinator.ts";
import { checkDdl } from "./ddl-forms.ts";
import type { DdlStatement, TableLock } from "./ddl-forms.ts";
import { DdlRefused } from "./ddl-refused.ts";
import { ExistingDataViolates } from "./existing-data-violates.ts";
import { ASSUME_POPULATED, planChangeSet, requiresSchemaKey } from "./plan.ts";
import type { ChangeSetPlan, Preflight, ViolationCheck } from "./plan.ts";
import type { PlatformTableMismatch } from "./platform-table-mismatch.ts";
import { insertSystemUser, verifyPlatformTable } from "./platform-tables.ts";
import type { SchemaBusy } from "./schema-busy.ts";
import { tableName } from "./sql-text.ts";
import {
  journalOperations,
  writeDefinitionRevisions,
  writeDefinitions,
  writeDependencies,
  writeEnforcementNotes,
  writeJournal,
} from "./writes.ts";

/** How many violating record IDs `ExistingDataViolates` carries. */
export const SAMPLE_IDS = 20;

/** A change set to apply. */
export interface ChangeSetRequest {
  readonly operations: readonly Operation[];
  /** The acting user; the system user by default (bootstrap and set loads). */
  readonly requesterId?: DefinitionId;
  /** Where the change set comes from, recorded in the journal. */
  readonly source?: JsonObject;
  /** A fixed change set ID; `uuidv7()` by default. */
  readonly changeSetId?: string;
}

/** Options of a change set. */
export type ChangeSetOptions = ConfigCommitOptions;

/** What applying a change set did. */
export interface ChangeSetResult {
  /** `unchanged`: nothing to do, no change set was recorded. */
  readonly state: "unchanged" | "completed" | "needs_attention";
  readonly changeSetId: string | null;
  /** The revision of the main transaction. */
  readonly revision: number | null;
  /** The revision of `complete`, if the change set had follow-up steps. */
  readonly completeRevision: number | null;
  /** The DDL the main transaction ran, in order. */
  readonly statements: readonly string[];
  /** The follow-up statements, in order. */
  readonly followUps: readonly string[];
  /** Milliseconds from `BEGIN` of the successful main transaction to `COMMIT`. */
  readonly mainTransactionMs: number;
  readonly error: string | null;
}

/** Errors of a change set. Nothing is applied when one is raised. */
export type ChangeSetError =
  | DefinitionInvalid
  | SchemaBusy
  | ExistingDataViolates
  | DdlRefused
  | PlatformTableMismatch
  | SchemaLockTimeout
  | DatabaseError;

/** Services a change set needs. */
export type ChangeSetServices =
  | Catalog
  | Transactions
  | DatabaseConfig
  | PgClient.PgClient
  | SqlClient.SqlClient;

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

const decodeExists = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeCount = decodeRows(Schema.Struct({ n: Schema.String }));

const apply = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  changeSetId: string
): Effect.Effect<AppliedChangeSet, DefinitionInvalid> => {
  const applied = applyOperations(snapshot, operations, {
    changeSetId,
    revision: snapshot.revision + 1,
  });

  return Result.isSuccess(applied)
    ? Effect.succeed(applied.success)
    : Effect.fail(applied.failure);
};

/**
 * Checks statements against the allowed DDL forms.
 *
 * @param statements - Generated DDL.
 * @returns Fails with `DdlRefused` for the first statement outside them.
 */
export const guardStatements = (
  statements: readonly string[]
): Effect.Effect<void, DdlRefused> => {
  for (const statement of statements) {
    const check = checkDdl(statement);

    if (!check.ok) {
      return Effect.fail(new DdlRefused({ reason: check.reason, statement }));
    }
  }

  return Effect.void;
};

/**
 * Every statement of a plan, main and follow-up, checked against the
 * allowed DDL forms before any of them runs.
 *
 * @param plan - The plan.
 * @returns Fails with the first refusal.
 */
export const guardPlan = (
  plan: ChangeSetPlan
): Effect.Effect<void, DdlRefused> =>
  guardStatements([
    ...plan.tables.map((statement) => statement.sql),
    ...plan.keys.map((statement) => statement.sql),
    ...plan.steps.flatMap((step) =>
      step.kind === "validate_override" || step.sql === null ? [] : [step.sql]
    ),
  ]);

/**
 * The time one attempt of a main transaction may spend waiting for table
 * locks, across all its DDL statements (Contracts 1.4). Postgres's
 * `lock_timeout` applies per lock, so a fixed 2 s would let an attempt that
 * waits on two ancestors in turn hold `CONFIG_KEY` for twice that.
 */
export const DDL_LOCK_BUDGET_MS = 2000;

/** The lock-wait budget of one main-transaction attempt. */
interface LockBudget {
  readonly deadline: number;
}

const remainingMs = (budget: LockBudget): number =>
  Math.max(1, budget.deadline - Date.now());

/**
 * Takes every table lock the DDL needs, one at a time, each with
 * `lock_timeout` set to what is left of the attempt's budget. Postgres
 * applies `lock_timeout` to each lock acquisition separately, so only
 * explicit locks keep the attempt's total wait within the budget; a lock
 * timeout rolls the attempt back and the config commit retries it.
 *
 * @param locks - The plan's locks, in order.
 * @returns The budget for the DDL that follows.
 */
const takeTableLocks = (locks: readonly TableLock[]) =>
  Effect.gen(function* takeLocksInOrder() {
    const sql = yield* SqlClient.SqlClient;
    const budget: LockBudget = { deadline: Date.now() + DDL_LOCK_BUDGET_MS };

    for (const lock of locks) {
      yield* sql.unsafe(`SET LOCAL lock_timeout = '${remainingMs(budget)}ms'`);
      yield* lockWaiting(
        sql.unsafe(`LOCK TABLE ${lock.table} IN ${lock.mode} MODE`)
      );
    }

    return budget;
  });

/**
 * Runs DDL whose table locks are already held. `lock_timeout` stays at what
 * is left of the budget (at least 1 ms), so a lock missing from the
 * inventory fails fast as a retryable lock timeout instead of waiting.
 *
 * @param statements - The statements, in order.
 * @param budget - The attempt's budget.
 * @returns An effect in the main transaction.
 */
const runDdl = (statements: readonly DdlStatement[], budget: LockBudget) =>
  Effect.gen(function* runMainDdl() {
    const sql = yield* SqlClient.SqlClient;

    for (const statement of statements) {
      const remaining = remainingMs(budget);

      yield* sql.unsafe(`SET LOCAL lock_timeout = '${remaining}ms'`);
      yield* lockWaiting(sql.unsafe(statement.sql));
    }
  });

const restoreLockTimeout = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) =>
    sql.unsafe(`SET LOCAL lock_timeout = '${MAIN_LOCK_TIMEOUT}'`)
  )
);

/** Everything the main transaction needs besides its services. */
interface MainInput {
  readonly request: ChangeSetRequest;
  readonly changeSetId: string;
  readonly preflight: Preflight;
  readonly coordinatorPid: number | null;
  readonly timing: { started: number; finished: number };
}

const mainTransaction = (input: MainInput) =>
  Effect.gen(function* runMainTransaction() {
    input.timing.started = Date.now();
    const state = yield* RequestRevision;
    const catalog = yield* Catalog;
    const snapshot = yield* catalog.at(state);

    const applied = yield* apply(
      snapshot,
      input.request.operations,
      input.changeSetId
    );

    const plan = planChangeSet(applied, input.preflight);
    const requesterId = input.request.requesterId ?? SYSTEM_USER_ID;
    const revision = state.revision + 1;

    if (input.coordinatorPid === null && requiresSchemaKey(applied)) {
      return yield* Effect.die(
        new Error("A change set with DDL ran without SCHEMA_KEY")
      );
    }

    yield* guardPlan(plan);

    for (const classId of plan.platformClasses) {
      yield* verifyPlatformTable(applied.after, classId);
    }

    const hasDdl = plan.tables.length > 0 || plan.keys.length > 0;
    const budget = yield* takeTableLocks(plan.locks);

    yield* runDdl(plan.tables, budget);

    if (plan.seedSystemUser) {
      yield* insertSystemUser(applied.after);
      yield* installSessionRevocation(applied.after);
    }

    yield* runDdl(plan.keys, budget);

    if (hasDdl) {
      yield* restoreLockTimeout;
    }

    yield* writeDefinitions(plan.definitions, applied.before, requesterId);
    yield* writeEnforcementNotes(plan.enforcementUpdates);
    yield* writeDefinitionRevisions(revision, plan.definitions);
    yield* writeDependencies(plan.definitions);
    yield* writeJournal({
      changeSetId: input.changeSetId,
      coordinatorPid: input.coordinatorPid,
      operations: journalOperations(applied),
      requesterId,
      revision,
      source: input.request.source ?? { kind: "api" },
      steps: plan.steps,
    });

    const next = yield* bumpRevision(input.changeSetId);
    input.timing.finished = Date.now();

    return { next, plan };
  });

const hasRows = (
  connection: DedicatedConnection,
  table: string
): Effect.Effect<boolean, DatabaseError> =>
  connection.execute(`SELECT EXISTS (SELECT 1 FROM ${table}) AS present`).pipe(
    Effect.flatMap(decodeExists),
    Effect.map(([row]) => row?.present === true)
  );

/**
 * Which existing tables hold rows. Index-only scans of the primary keys
 * (`enable_seqscan = off`), so the check costs a page and never shows up as
 * a sequential scan of the table.
 *
 * @param connection - The coordinator's connection.
 * @param applied - The change set applied in memory.
 * @returns The preflight.
 */
const checkExistence = (
  connection: DedicatedConnection,
  applied: AppliedChangeSet
): Effect.Effect<Preflight, DatabaseError> =>
  Effect.gen(function* checkTablesForRows() {
    const { existenceChecks } = planChangeSet(applied, ASSUME_POPULATED);
    const populated = new Set<DefinitionId>();

    yield* connection.execute("SET enable_seqscan = off");

    for (const classId of existenceChecks) {
      if (yield* hasRows(connection, tableName(applied.after, classId))) {
        populated.add(classId);
      }
    }

    yield* connection.execute("RESET enable_seqscan");

    return { hasRows: (classId: DefinitionId) => populated.has(classId) };
  });

const countViolations = (
  connection: DedicatedConnection,
  check: ViolationCheck
): Effect.Effect<void, ExistingDataViolates | DatabaseError> =>
  Effect.gen(function* countViolatingRows() {
    const [counted] = yield* connection
      .execute(
        `SELECT count(*) AS n FROM ${check.table} WHERE ${check.predicate}`
      )
      .pipe(Effect.flatMap(decodeCount));

    const count = Number(counted?.n ?? "0");

    if (count === 0) {
      return yield* Effect.void;
    }

    const samples = yield* connection
      .execute(
        `SELECT id::text AS id FROM ${check.table} WHERE ${check.predicate} ORDER BY id LIMIT ${SAMPLE_IDS}`
      )
      .pipe(Effect.flatMap(decodeId));

    return yield* new ExistingDataViolates({
      count,
      definitionId: check.definitionId,
      sampleIds: samples.map((row) => row.id),
    });
  });

const newChangeSetId = hygienic(
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql`SELECT uuidv7()::text AS id`),
    Effect.flatMap(decodeId),
    Effect.map(([row]) => row?.id ?? "")
  )
);

const unchanged: ChangeSetResult = {
  changeSetId: null,
  completeRevision: null,
  error: null,
  followUps: [],
  mainTransactionMs: 0,
  revision: null,
  state: "unchanged",
  statements: [],
};

const resultOf = (
  changeSetId: string,
  committed: {
    readonly next: { readonly revision: number };
    readonly plan: ChangeSetPlan;
  },
  timing: { readonly started: number; readonly finished: number }
): ChangeSetResult => ({
  changeSetId,
  completeRevision: null,
  error: null,
  followUps: committed.plan.steps.flatMap((step) =>
    step.sql === null ? [] : [step.sql]
  ),
  mainTransactionMs: timing.finished - timing.started,
  revision: committed.next.revision,
  state: "completed",
  statements: [...committed.plan.tables, ...committed.plan.keys].map(
    (statement) => statement.sql
  ),
});

const withCoordinator = (
  request: ChangeSetRequest,
  changeSetId: string,
  options: ChangeSetOptions | undefined
): Effect.Effect<
  ChangeSetResult,
  ChangeSetError,
  ChangeSetServices | Scope.Scope
> =>
  Effect.gen(function* coordinateChangeSet() {
    const catalog = yield* Catalog;
    const connection = yield* openCoordinator;
    const snapshot = yield* catalog.refresh;
    const applied = yield* apply(snapshot, request.operations, changeSetId);
    const preflight = yield* checkExistence(connection, applied);
    const plan = planChangeSet(applied, preflight);

    for (const check of plan.violations) {
      yield* countViolations(connection, check);
    }

    yield* guardPlan(plan);

    const timing = { finished: 0, started: 0 };

    const committed = yield* connection.transactions.configCommit(
      mainTransaction({
        changeSetId,
        coordinatorPid: connection.processId,
        preflight,
        request,
        timing,
      }),
      options
    );

    const result = resultOf(changeSetId, committed, timing);

    if (committed.plan.steps.length === 0) {
      return result;
    }

    const outcome = yield* runFollowUps(connection, changeSetId, options);

    return {
      ...result,
      completeRevision: outcome.revision,
      error: outcome.error,
      state: outcome.state,
    };
  });

/**
 * Applies a change set.
 *
 * @param request - The operations, requester and source.
 * @param options - Retry delays of the config commits.
 * @returns What was applied.
 */
export const applyChangeSet = (
  request: ChangeSetRequest,
  options?: ChangeSetOptions
): Effect.Effect<ChangeSetResult, ChangeSetError, ChangeSetServices> =>
  Effect.gen(function* applyChangeSetRequest() {
    const catalog = yield* Catalog;
    const { configCommit } = yield* Transactions;
    const snapshot = yield* catalog.refresh;
    const probeId = request.changeSetId ?? snapshot.changeSetId;
    const applied = yield* apply(snapshot, request.operations, probeId);

    if (applied.changes.length === 0) {
      return unchanged;
    }

    const changeSetId = request.changeSetId ?? (yield* newChangeSetId);

    if (requiresSchemaKey(applied)) {
      return yield* Effect.scoped(
        withCoordinator(request, changeSetId, options)
      );
    }

    const timing = { finished: 0, started: 0 };

    const committed = yield* configCommit(
      mainTransaction({
        changeSetId,
        coordinatorPid: null,
        preflight: ASSUME_POPULATED,
        request,
        timing,
      }),
      options
    );

    return resultOf(changeSetId, committed, timing);
  });
