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
 *    (`SchemaBusy` if another change set holds it), first resumes change
 *    sets an earlier coordinator left in `applying` and refuses while one
 *    is `needs_attention` (`SchemaNeedsAttention`), then checks which tables
 *    hold rows and counts violating rows (`ExistingDataViolates` with up to
 *    20 sample IDs), counts the values or rows each purge destroys and
 *    checks that a purged child class leaves no records behind
 *    (`PurgeRefused`), and checks every planned statement against the
 *    allowed DDL forms (`DdlRefused`), all before `CONFIG_KEY` and before
 *    any DDL.
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
import type { NotAllowed } from "@std/api/errors/not-allowed";
import type { NotFound } from "@std/api/errors/not-found";
import type { SchemaChanged } from "@std/api/errors/schema-changed";
import type { Unauthenticated } from "@std/api/errors/unauthenticated";
import type { UnknownField } from "@std/api/errors/unknown-field";
import type { UnknownTable } from "@std/api/errors/unknown-table";
import type { VersionConflict } from "@std/api/errors/version-conflict";
import { applyOperations } from "@std/definitions/apply";
import type {
  ApplyContext,
  ApplyError,
  AppliedChangeSet,
} from "@std/definitions/apply";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import { PurgeRefused } from "@std/definitions/purge-refused";
import type { ChangeSetRefusal } from "@std/definitions/refusals";
import { LOCAL_ORIGIN, SYSTEM_REQUESTER } from "@std/definitions/requester";
import type { ChangeOrigin, Requester } from "@std/definitions/requester";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_ROLE_CLASS_ID } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Clock, Effect, Result, Schema } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { installSessionRevocation } from "../auth/session-revocation.ts";
import { Catalog } from "../catalog/catalog.ts";
import type { InstanceSettings } from "../config/instance-settings.ts";
import { writeResourceTopicChanges } from "../events/resource-topics.ts";
import type { TooManyRequests } from "../events/too-many-requests.ts";
import type { ChangeCause } from "../records/change-entry.ts";
import { bumpRevision } from "../sql/config-commit.ts";
import type {
  ConfigCommitOptions,
  SchemaLockTimeout,
} from "../sql/config-commit.ts";
import type { DatabaseConfig } from "../sql/database-config.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import type { CurrentTransaction } from "../sql/transaction-context.ts";
import { Transactions } from "../sql/transactions.ts";
import { writeConfigDeliveries } from "./config-deliveries.ts";
import { ConfigStateChanged } from "./config-state-changed.ts";
import { openCoordinator, runFollowUps } from "./coordinator.ts";
import { checkDdl } from "./ddl-forms.ts";
import { DdlRefused } from "./ddl-refused.ts";
import { writeDefinitionChanges } from "./definition-changes.ts";
import { ExistingDataViolates } from "./existing-data-violates.ts";
import { restoreLockTimeout, runDdl, takeTableLocks } from "./lock-budget.ts";
import type { RowCheck } from "./plan-lifecycle.ts";
import { ASSUME_POPULATED, planChangeSet, requiresSchemaKey } from "./plan.ts";
import type { ChangeSetPlan, Preflight } from "./plan.ts";
import type { PlatformTableMismatch } from "./platform-table-mismatch.ts";
import { insertSystemUser, verifyPlatformTable } from "./platform-tables.ts";
import { stepBoundary } from "./recovery-settings.ts";
import { settleOpenChangeSets } from "./recovery.ts";
import type { SchemaBusy } from "./schema-busy.ts";
import type { SchemaNeedsAttention } from "./schema-needs-attention.ts";
import { quoteIdent, tableName } from "./sql-text.ts";
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

/** What the main transaction knows when it writes other config tables. */
export interface MainTransactionContext {
  readonly changeSetId: string;
  /** The revision the main transaction commits. */
  readonly revision: number;
  readonly requesterId: DefinitionId;
}

/**
 * Writes of other config tables (the config layers, Contracts 8.2) that
 * belong to a change set's main transaction, after the definition rows.
 */
export interface ExtraWrites {
  /**
   * Whether the writes change anything: a change set without definition
   * changes still commits when true.
   */
  readonly pending: boolean;
  /**
   * The records whose `adopt` these writes plan: the config layers checked
   * that their set removed them and delete their base rows (Contracts
   * 8.1). The schema engine refuses any other `adopt`.
   */
  readonly adopted?: readonly DefinitionId[];
  readonly write: (
    context: MainTransactionContext
  ) => Effect.Effect<void, SqlError, SqlClient.SqlClient>;
}

/** A change set to apply. */
export interface ChangeSetRequest {
  readonly operations: readonly Operation[];
  /**
   * The acting user and the roles they hold; the system user without
   * roles by default (bootstrap and set loads). Permissions such as
   * `schema.purge` are checked against it.
   */
  readonly requester?: Requester;
  /**
   * A local edit (the default) or a definition set load, which owns its
   * definitions (Contracts 1.8).
   */
  readonly origin?: ChangeOrigin;
  /** Where the change set comes from, recorded in the journal. */
  readonly source?: JsonObject;
  /** A fixed change set ID; `uuidv7()` by default. */
  readonly changeSetId?: string;
  /**
   * The cause recorded on the definitions' change entries (Contracts 4.2):
   * `api` by default, `system` for set loads.
   */
  readonly cause?: ChangeCause;
  /**
   * Checks the requester again inside the main transaction, against the
   * snapshot held under exclusive `CONFIG_KEY` and before any write: the
   * HTTP layer re-checks the session, the stated revision (6.4) and the
   * access rules there, so nothing can change between the check and the
   * commit (Contracts 1.4). It returns the requester as authenticated now
   * (its roles at this snapshot), which every permission check of the
   * change set (`schema.purge`) then uses, on every commit attempt.
   */
  readonly authorize?: (
    snapshot: ConfigSnapshot
  ) => Effect.Effect<Requester, ChangeSetAuthorizationError, AuthorizeServices>;
  /** Other config-table writes in the main transaction. */
  readonly extraWrites?: ExtraWrites;
  /**
   * The state the change set was planned at. The main transaction fails
   * with `ConfigStateChanged` when another config commit came first.
   */
  readonly expectedState?: ConfigState;
}

/** What a change set's `authorize` check can refuse with. */
export type ChangeSetAuthorizationError =
  | TooManyRequests
  | DefinitionInvalid
  | NotAllowed
  | NotFound
  | Unauthenticated
  | SchemaChanged
  | UnknownTable
  | UnknownField
  | VersionConflict;

/** What a change set's `authorize` check may use: the main transaction. */
export type AuthorizeServices =
  | SqlClient.SqlClient
  | RequestRevision
  | CurrentTransaction;

/** Options of a change set. */
export interface ChangeSetOptions extends ConfigCommitOptions {
  /**
   * A dedicated connection that already holds `SCHEMA_KEY` (`std upgrade`
   * holds it for the whole run); the change set uses it instead of taking
   * the lock on a connection of its own.
   */
  readonly coordinator?: DedicatedConnection;
}

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
  /** Values or rows each purged definition destroyed (Contracts 1.6). */
  readonly destroyed: ReadonlyMap<DefinitionId, number>;
  /**
   * User-role assignments of each retired or deleted role, reported but
   * allowed (Contracts 1.7); the assignments themselves stay.
   */
  readonly assignments: ReadonlyMap<DefinitionId, number>;
  /** What the journal recorded per operation (cascades, reported dependents). */
  readonly operations: readonly JsonObject[];
}

/** Errors of a change set. Nothing is applied when one is raised. */
export type ChangeSetError =
  | DefinitionInvalid
  | ChangeSetRefusal
  | ChangeSetAuthorizationError
  | ConfigStateChanged
  | SchemaBusy
  | SchemaNeedsAttention
  | ExistingDataViolates
  | DdlRefused
  | PlatformTableMismatch
  | SchemaLockTimeout
  | DatabaseError;

/** Services a change set needs. */
export type ChangeSetServices =
  | InstanceSettings
  | Catalog
  | Transactions
  | DatabaseConfig
  | PgClient.PgClient
  | SqlClient.SqlClient;

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

const decodeExists = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeCount = decodeRows(Schema.Struct({ n: Schema.String }));

/**
 * The cause of a change set's change entries when the request names none:
 * `system` for definition set loads, `api` otherwise.
 *
 * @param source - The journal source.
 * @returns The cause.
 */
const causeOf = (source: JsonObject | undefined): ChangeCause =>
  source?.kind === "set" ? { kind: "system" } : { kind: "api" };

/**
 * The requester and origin of a change set.
 *
 * @param request - The change set.
 * @returns Its apply context.
 */
export const contextOf = (request: ChangeSetRequest): ApplyContext => ({
  origin: request.origin ?? LOCAL_ORIGIN,
  requester: request.requester ?? SYSTEM_REQUESTER,
});

/**
 * An `adopt` the config layers did not plan: it would move a record into
 * the local layer and leave its base row, so the next upgrade could not
 * plan the set.
 *
 * @param request - The change set.
 * @returns The refusal, or undefined.
 */
const unplannedAdopt = (
  request: ChangeSetRequest
): DefinitionInvalid | undefined => {
  const planned: ReadonlySet<string> = new Set(request.extraWrites?.adopted);

  const found = request.operations.find(
    (operation) => operation.op === "adopt" && !planned.has(operation.id)
  );

  return found === undefined || found.op !== "adopt"
    ? undefined
    : new DefinitionInvalid({
        problems: [
          problem(
            "unsupportedChange",
            found.id,
            "adopt runs only through the config layers, which check that the record's set removed it and delete its base row and overrides."
          ),
        ],
      });
};

const apply = (
  snapshot: ConfigSnapshot,
  request: ChangeSetRequest,
  changeSetId: string
): Effect.Effect<AppliedChangeSet, ApplyError> => {
  const unplanned = unplannedAdopt(request);

  if (unplanned !== undefined) {
    return Effect.fail(unplanned);
  }

  const applied = applyOperations(
    snapshot,
    request.operations,
    { changeSetId, revision: snapshot.revision + 1 },
    contextOf(request)
  );

  return Result.isSuccess(applied)
    ? Effect.succeed(applied.success)
    : Effect.fail(applied.failure);
};

/**
 * Applies the operations in memory, as every step before the main
 * transaction does. A request with an `authorize` check runs it first, in
 * one read transaction against the same snapshot, so no refusal about a
 * target (a version conflict, an unknown definition, a dependency) reaches
 * a caller whose stated revision no longer holds or who may not see the
 * target (Contracts 3.8, 3.9, 6.4); the requester's roles come from that
 * check. Without one (bootstrap, set loads, internal callers) it applies
 * against the catalog's current snapshot.
 *
 * @param request - The change set.
 * @param changeSetId - The change set ID the result carries; the
 *   snapshot's for a probe before the ID is drawn.
 * @returns The change set applied in memory.
 */
const validate = Effect.fn("Schema.validate")(function* validate(
  request: ChangeSetRequest,
  changeSetId: string | undefined
) {
  const catalog = yield* Catalog;
  const { authorize } = request;

  if (authorize === undefined) {
    const snapshot = yield* catalog.refresh;

    return yield* apply(snapshot, request, changeSetId ?? snapshot.changeSetId);
  }

  const transactions = yield* Transactions;

  return yield* transactions.request(
    Effect.gen(function* checkedApply() {
      const snapshot = yield* catalog.at(yield* RequestRevision);
      const requester = yield* authorize(snapshot);

      return yield* apply(
        snapshot,
        { ...request, requester },
        changeSetId ?? snapshot.changeSetId
      );
    })
  );
});

/**
 * Runs the request's check alone, in a read transaction at the current
 * snapshot.
 *
 * @param request - The change set.
 * @returns Fails with the check's refusal.
 */
const recheck = Effect.fn("Schema.recheck")(function* recheck(
  request: ChangeSetRequest
) {
  const { authorize } = request;

  if (authorize === undefined) {
    return yield* Effect.void;
  }

  const catalog = yield* Catalog;
  const transactions = yield* Transactions;

  return yield* transactions.request(
    Effect.gen(function* checkNow() {
      yield* authorize(yield* catalog.at(yield* RequestRevision));
    })
  );
});

/**
 * Preflight work outside `CONFIG_KEY` (existence, violation and purge
 * scans, which can take long and must not hold it): any refusal it ends in
 * may carry target data (counts, sample record IDs), so the request's
 * check runs again at the then-current snapshot first, and its refusal
 * wins (Contracts 3.8: a target hidden meanwhile is reported like a
 * missing one).
 *
 * @param request - The change set.
 * @returns The combinator.
 */
const checkedPreflight =
  (request: ChangeSetRequest) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // A refusal of the check replaces the preflight's own.
    effect.pipe(Effect.tapError(() => recheck(request)));

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

/** Everything the main transaction needs besides its services. */
interface MainInput {
  readonly request: ChangeSetRequest;
  readonly changeSetId: string;
  readonly preflight: Preflight;
  readonly coordinatorPid: number | null;
  /** Values or rows each purge destroys, counted before `CONFIG_KEY`. */
  readonly destroyed: ReadonlyMap<DefinitionId, number>;
  /** User-role assignments of retired or deleted roles. */
  readonly assignments: ReadonlyMap<DefinitionId, number>;
}

const mainTransaction = Effect.fn("Schema.mainTransaction")(
  function* mainTransaction(input: MainInput) {
    const started = yield* Clock.currentTimeMillis;
    const state = yield* RequestRevision;
    const expected = input.request.expectedState;

    if (
      expected !== undefined &&
      (expected.revision !== state.revision ||
        expected.changeSetId !== state.changeSetId)
    ) {
      return yield* new ConfigStateChanged({
        actualChangeSetId: state.changeSetId,
        actualRevision: state.revision,
        expectedChangeSetId: expected.changeSetId,
        expectedRevision: expected.revision,
      });
    }

    const catalog = yield* Catalog;
    const snapshot = yield* catalog.at(state);

    // The requester as re-authenticated under CONFIG_KEY: its roles now,
    // not when the request was checked, decide every permission.
    const requester =
      input.request.authorize === undefined
        ? contextOf(input.request).requester
        : yield* input.request.authorize(snapshot);

    const request = { ...input.request, requester };
    const applied = yield* apply(snapshot, request, input.changeSetId);

    const plan = planChangeSet(applied, input.preflight);
    const requesterId = requester.userId;
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
      yield* insertSystemUser(applied.after, revision);
      yield* installSessionRevocation(applied.after);
    }

    yield* runDdl(plan.keys, budget);

    if (hasDdl) {
      yield* restoreLockTimeout;
    }

    yield* writeDefinitions(plan.definitions, applied.before, requesterId);

    const written = yield* writeDefinitionChanges(
      applied.after,
      plan.definitions.map((after) => ({
        after,
        before: applied.before.get(after.id),
      })),
      requesterId,
      input.request.cause ?? causeOf(input.request.source),
      revision
    );

    yield* writeConfigDeliveries(applied.after, written, requesterId, revision);
    yield* writeEnforcementNotes(plan.enforcementUpdates);
    yield* writeDefinitionRevisions(revision, plan.definitions);
    yield* writeResourceTopicChanges(
      applied.before,
      applied.after,
      plan.definitions,
      requesterId,
      revision
    );
    yield* writeDependencies(plan.definitions);

    const operations = journalOperations(
      applied,
      input.destroyed,
      input.assignments
    );

    yield* writeJournal({
      changeSetId: input.changeSetId,
      coordinatorPid: input.coordinatorPid,
      operations,
      requesterId,
      revision,
      source: input.request.source ?? { kind: "api" },
      steps: plan.steps,
    });

    if (input.request.extraWrites !== undefined) {
      yield* input.request.extraWrites.write({
        changeSetId: input.changeSetId,
        requesterId,
        revision,
      });
    }

    const next = yield* bumpRevision(input.changeSetId);
    const finished = yield* Clock.currentTimeMillis;

    return { mainTransactionMs: finished - started, next, operations, plan };
  }
);

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
const checkExistence = Effect.fn("Schema.checkExistence")(
  function* checkExistence(
    connection: DedicatedConnection,
    applied: AppliedChangeSet
  ): Effect.fn.Return<Preflight, DatabaseError> {
    const { existenceChecks } = planChangeSet(applied, ASSUME_POPULATED);
    const populated = new Set<DefinitionId>();

    yield* connection.execute("SET enable_seqscan = off");

    for (const classId of existenceChecks) {
      // Before any DDL: tables still have their names from before the
      // change set.
      if (yield* hasRows(connection, tableName(applied.before, classId))) {
        populated.add(classId);
      }
    }

    yield* connection.execute("RESET enable_seqscan");

    return { hasRows: (classId: DefinitionId) => populated.has(classId) };
  }
);

const countRows = (
  connection: DedicatedConnection,
  check: RowCheck
): Effect.Effect<number, DatabaseError> =>
  connection
    .execute(
      `SELECT count(*) AS n FROM ${check.table} WHERE ${check.predicate}`
    )
    .pipe(
      Effect.flatMap(decodeCount),
      Effect.map(([row]) => Number(row?.n ?? "0"))
    );

const countViolations = Effect.fn("Schema.countViolations")(
  function* countViolations(
    connection: DedicatedConnection,
    check: RowCheck
  ): Effect.fn.Return<void, ExistingDataViolates | DatabaseError> {
    const count = yield* countRows(connection, check);

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
  }
);

/**
 * Counts what each purge destroys (Contracts 1.6), under `SCHEMA_KEY` and
 * before `CONFIG_KEY`: a retired field or table refuses writes, so the
 * count is stable. Refuses a purged child class whose records also have
 * rows in ancestor tables that stay.
 *
 * @param connection - The coordinator's connection.
 * @param plan - The plan.
 * @returns Values or rows per purged definition.
 */
const countPurges = Effect.fn("Schema.countPurges")(function* countPurges(
  connection: DedicatedConnection,
  plan: ChangeSetPlan
): Effect.fn.Return<
  ReadonlyMap<DefinitionId, number>,
  PurgeRefused | DatabaseError
> {
  for (const check of plan.recordChecks) {
    const count = yield* countRows(connection, check);

    if (count > 0) {
      return yield* new PurgeRefused({
        count,
        definitionId: check.definitionId,
        reason: "hasRecords",
      });
    }
  }

  const destroyed = new Map<DefinitionId, number>();

  for (const count of plan.purgeCounts) {
    destroyed.set(count.definitionId, yield* countRows(connection, count));
  }

  return destroyed;
});

/**
 * The roles a change set retires or deletes.
 *
 * @param applied - The applied change set.
 * @returns Their IDs.
 */
const endedRoles = (applied: AppliedChangeSet): readonly DefinitionId[] =>
  applied.changes.flatMap(({ before, after }) =>
    before?.kind === "role" &&
    before.state !== after.state &&
    after.state !== "active"
      ? [after.id]
      : []
  );

/**
 * Counts the user-role assignments of each role the change set retires or
 * deletes (Contracts 1.7: reported but allowed). It reads data, so it runs
 * on the pool before `CONFIG_KEY`; the number is a report, and assignments
 * made meanwhile are not refused anyway.
 *
 * @param applied - The applied change set.
 * @returns Assignments per role.
 */
const countAssignments = Effect.fn("Schema.countAssignments")(
  function* countAssignments(applied: AppliedChangeSet) {
    const counts = new Map<DefinitionId, number>();
    const roles = endedRoles(applied);
    const roleField = applied.before.fieldByName(USER_ROLE_CLASS_ID, "role");

    if (
      roles.length === 0 ||
      roleField === undefined ||
      applied.before.class(USER_ROLE_CLASS_ID)?.storage !== "standard"
    ) {
      return counts;
    }

    const sql = yield* SqlClient.SqlClient;
    const table = tableName(applied.before, USER_ROLE_CLASS_ID);

    for (const roleId of roles) {
      const [row] = yield* sql
        .unsafe(
          `SELECT count(*) AS n FROM ${table} WHERE ${quoteIdent(roleField.name)} = $1::uuid`,
          [roleId]
        )
        .pipe(Effect.flatMap(decodeCount));

      counts.set(roleId, Number(row?.n ?? "0"));
    }

    return counts;
  },
  hygienic
);

const newChangeSetId = hygienic(
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql`SELECT uuidv7()::text AS id`),
    Effect.flatMap(decodeId),
    Effect.map(([row]) => row?.id ?? "")
  )
);

const unchanged: ChangeSetResult = {
  assignments: new Map(),
  changeSetId: null,
  completeRevision: null,
  destroyed: new Map(),
  error: null,
  followUps: [],
  mainTransactionMs: 0,
  operations: [],
  revision: null,
  state: "unchanged",
  statements: [],
};

const resultOf = (
  changeSetId: string,
  committed: {
    readonly mainTransactionMs: number;
    readonly next: { readonly revision: number };
    readonly plan: ChangeSetPlan;
    readonly operations: readonly JsonObject[];
  },
  destroyed: ReadonlyMap<DefinitionId, number>,
  assignments: ReadonlyMap<DefinitionId, number>
): ChangeSetResult => ({
  assignments,
  changeSetId,
  completeRevision: null,
  destroyed,
  error: null,
  followUps: committed.plan.steps.flatMap((step) =>
    step.sql === null ? [] : [step.sql]
  ),
  mainTransactionMs: committed.mainTransactionMs,
  operations: committed.operations,
  revision: committed.next.revision,
  state: "completed",
  statements: [...committed.plan.tables, ...committed.plan.keys].map(
    (statement) => statement.sql
  ),
});

const withCoordinator = Effect.fn("Schema.withCoordinator")(
  function* withCoordinator(
    request: ChangeSetRequest,
    changeSetId: string,
    options: ChangeSetOptions | undefined,
    assignments: ReadonlyMap<DefinitionId, number>
  ): Effect.fn.Return<
    ChangeSetResult,
    ChangeSetError,
    ChangeSetServices | Scope.Scope
  > {
    const connection = options?.coordinator ?? (yield* openCoordinator);

    // Whoever holds SCHEMA_KEY (a coordinator of its own, or std upgrade's
    // connection) finishes interrupted change sets first.
    yield* settleOpenChangeSets(connection, options);

    const applied = yield* validate(request, changeSetId);

    yield* stepBoundary("before:preflight");

    const { destroyed, plan, preflight } = yield* Effect.gen(function* scans() {
      const existence = yield* checkExistence(connection, applied);
      const planned = planChangeSet(applied, existence);

      for (const check of planned.violations) {
        yield* countViolations(connection, check);
      }

      return {
        destroyed: yield* countPurges(connection, planned),
        plan: planned,
        preflight: existence,
      };
    }).pipe(checkedPreflight(request));

    yield* guardPlan(plan);

    const committed = yield* connection.transactions.configCommit(
      mainTransaction({
        assignments,
        changeSetId,
        coordinatorPid: connection.processId,
        destroyed,
        preflight,
        request,
      }),
      options
    );

    const result = resultOf(changeSetId, committed, destroyed, assignments);

    if (committed.plan.steps.length === 0) {
      return result;
    }

    yield* stepBoundary("committed");

    const outcome = yield* runFollowUps(connection, changeSetId, options);

    return {
      ...result,
      completeRevision: outcome.revision,
      error: outcome.error,
      state: outcome.state,
    };
  }
);

/**
 * Applies a change set.
 *
 * @param request - The operations, requester and source.
 * @param options - Retry delays of the config commits.
 * @returns What was applied.
 */
export const applyChangeSet = Effect.fn("Schema.applyChangeSet")(
  function* applyChangeSet(
    request: ChangeSetRequest,
    options?: ChangeSetOptions
  ): Effect.fn.Return<ChangeSetResult, ChangeSetError, ChangeSetServices> {
    const { configCommit } = yield* Transactions;
    const applied = yield* validate(request, request.changeSetId);

    if (applied.changes.length === 0 && request.extraWrites?.pending !== true) {
      return unchanged;
    }

    const changeSetId = request.changeSetId ?? (yield* newChangeSetId);
    const assignments = yield* countAssignments(applied);

    if (requiresSchemaKey(applied)) {
      return yield* Effect.scoped(
        withCoordinator(request, changeSetId, options, assignments)
      );
    }

    const committed = yield* configCommit(
      mainTransaction({
        assignments,
        changeSetId,
        coordinatorPid: null,
        destroyed: new Map(),
        preflight: ASSUME_POPULATED,
        request,
      }),
      options
    );

    return resultOf(changeSetId, committed, new Map(), assignments);
  }
);
