/**
 * STD's transactions (Contracts 1.3, 1.4, 4.1).
 *
 * Every transaction STD opens goes through this module or `config-commit.ts`:
 *
 * - Request transactions (`request`): `BEGIN ISOLATION LEVEL READ COMMITTED`,
 *   then `SET LOCAL statement_timeout = '30s'` and
 *   `SET LOCAL idle_in_transaction_session_timeout = '10s'`, then the first
 *   query, `SELECT revision, change_set_id FROM core.begin_request()`. The
 *   revision is available to the transaction's code as `RequestRevision`.
 *   Requests, batches and worker transactions all use them.
 * - Config commits (`config-commit.ts`): the main transaction of a change
 *   set, under `CONFIG_KEY` exclusive, with lock-timeout retries.
 * - Maintenance transactions (`maintenance`): plain READ COMMITTED
 *   transactions for platform migrations.
 *
 * Rules shared by all of them:
 *
 * - Only READ COMMITTED. Asking for another isolation level, or running
 *   `SET TRANSACTION ... ISOLATION LEVEL` inside, is refused with a
 *   `TransactionRefused` defect.
 * - A nested unit (`request` or `configCommit` inside a running transaction)
 *   joins the outer transaction. No `SAVEPOINT` is ever issued: `SAVEPOINT`,
 *   `RELEASE` and `ROLLBACK TO` inside an STD transaction are refused, and
 *   so is every other transaction-control statement. Effect's own nested
 *   `withTransaction` dies before sending anything inside an STD
 *   transaction (its savepoint path needs a semaphore that only its own
 *   outer `withTransaction` provides).
 * - Poisoning: when a nested unit fails after one of its statements ran
 *   (every statement counts as a potential write unless it is marked
 *   `readOnly`, see `statement-marks.ts`), or any statement in the
 *   transaction fails (Postgres has then aborted the transaction), the
 *   transaction is poisoned. A poisoned transaction is
 *   never committed: it is rolled back and dies with a `TransactionRefused`
 *   defect (reason `poisoned`), which is logged, whether or not the caller
 *   handled the original error.
 * - Post-commit actions registered with `CurrentTransaction.afterCommit` run
 *   after the outermost transaction commits and its connection is released;
 *   their failures are logged, not raised.
 * - The transaction's code runs in its own fiber with its own `Scope`.
 *   Before the layer decides whether to commit, that fiber has ended, which
 *   interrupts and awaits every fiber it forked, and the scope is closed,
 *   which interrupts fibers forked into it. Once `COMMIT` or `ROLLBACK` has
 *   run, the transaction is closed: its connection, its handle and joining
 *   it are refused with `TransactionRefused` (reason `closed`).
 * - Statement texts are lexed (`statement-lexer.ts`): transaction control,
 *   savepoints, isolation changes and multi-statement texts are refused
 *   before they are sent, whatever comments, quoting or punctuation they use.
 * - Driver errors are sanitized at the statement (`sanitizing-client.ts`)
 *   and leave as `DatabaseError` (SQLSTATE and constraint only).
 */
import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { hygienic } from "./errors.ts";
import type { HygienicError } from "./errors.ts";
import { parseConfigState, RequestRevision } from "./request-revision.ts";
import type { ConfigState } from "./request-revision.ts";
import { decodeRows } from "./rows.ts";
import { discardConnection } from "./sanitizing-client.ts";
import { CurrentTransaction } from "./transaction-context.ts";
import type { TransactionKind } from "./transaction-context.ts";
import { TransactionRefused } from "./transaction-refused.ts";
import {
  commit,
  control,
  trackConnection,
  TransactionState,
} from "./transaction-state.ts";

/** Postgres isolation levels, as accepted by `BEGIN ISOLATION LEVEL`. */
export type IsolationLevel =
  | "read committed"
  | "repeatable read"
  | "serializable";

/** The only isolation level STD runs request, batch and worker transactions at. */
export const REQUEST_ISOLATION: IsolationLevel = "read committed";

/** `statement_timeout` of request transactions (Contracts 1.3). */
export const REQUEST_STATEMENT_TIMEOUT = "30s";

/** `idle_in_transaction_session_timeout` of request transactions (Contracts 1.3). */
export const REQUEST_IDLE_TIMEOUT = "10s";

/** The statement every STD transaction starts with. */
export const BEGIN_STATEMENT = "BEGIN ISOLATION LEVEL READ COMMITTED";

/**
 * How a diagnostic transaction (`doctor`) begins: one snapshot for every
 * statement, and Postgres refuses any write.
 */
export const DIAGNOSTIC_BEGIN_STATEMENT =
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** The isolation level of diagnostic transactions. */
export const DIAGNOSTIC_ISOLATION: IsolationLevel = "repeatable read";

/**
 * `lock_timeout` of diagnostic transactions: a read that would wait longer
 * for a table lock (a schema change's DDL holding ACCESS EXCLUSIVE) fails
 * instead of stalling `doctor`.
 */
export const DIAGNOSTIC_LOCK_TIMEOUT = "5s";

const isolationOf = (kind: TransactionKind): IsolationLevel =>
  kind === "diagnostic" ? DIAGNOSTIC_ISOLATION : REQUEST_ISOLATION;

/** The first query of every request transaction. */
export const BEGIN_REQUEST_QUERY =
  "SELECT revision, change_set_id FROM core.begin_request()";

/** Services a maintenance transaction provides to its code. */
export type MaintenanceServices =
  | CurrentTransaction
  | SqlClient.SqlClient
  | SqlClient.TransactionConnection
  | PgClient.PgClient
  | Scope.Scope;

/** Services a request or config-commit transaction provides to its code. */
export type TransactionServices = MaintenanceServices | RequestRevision;

/** Options of a request transaction. */
export interface RequestOptions {
  /** Must be READ COMMITTED if given; anything else is refused with a defect. */
  readonly isolation?: IsolationLevel;
}

/** A Postgres duration literal, for example `2s` or `200ms`. */
export type PgDuration = `${number}${"ms" | "s"}`;

/** Options of a maintenance transaction. */
export interface MaintenanceOptions {
  readonly lockTimeout?: PgDuration;
  readonly statementTimeout?: PgDuration;
}

/** Statements after `BEGIN` and before the caller's code. */
export type TransactionSetup<S> = (
  connection: Connection,
  state: TransactionState
) => Effect.Effect<S, SqlError, Scope.Scope>;

/** How an outermost transaction ended. */
type Outcome<A, E> =
  | { readonly _tag: "Committed"; readonly value: A }
  | { readonly _tag: "Poisoned"; readonly reason: string }
  | { readonly _tag: "Refused"; readonly defect: TransactionRefused }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<E | SqlError> };

/** An outcome, and whether the connection ended the transaction cleanly. */
interface Settled<A, E> {
  readonly outcome: Outcome<A, E>;
  readonly clean: boolean;
}

/** The transaction-local setting that identifies an STD transaction. */
export const TRANSACTION_TOKEN_SETTING = "std.transaction_token";

const maintenanceContext = (
  state: TransactionState,
  tracked: Connection,
  scope: Scope.Scope
): Context.Context<MaintenanceServices> =>
  Context.make(CurrentTransaction, state).pipe(
    Context.add(SqlClient.SqlClient, state.client),
    Context.add(PgClient.PgClient, state.client),
    Context.add(state.client.transactionService, [tracked, 0]),
    Context.add(Scope.Scope, scope)
  );

const transactionContext = (
  state: TransactionState,
  tracked: Connection,
  scope: Scope.Scope,
  configState: ConfigState
): Context.Context<TransactionServices> =>
  maintenanceContext(state, tracked, scope).pipe(
    Context.add(RequestRevision, configState)
  );

/**
 * An exit that fails when the work or any of its cleanups failed.
 * @param exit - The work's exit.
 * @param cleanups - Exits of the cleanups that ran after it.
 * @returns The work's exit, or a failure combining every failure.
 */
const withCleanups = <A, E>(
  exit: Exit.Exit<A, E>,
  cleanups: readonly Exit.Exit<void>[]
): Exit.Exit<A, E> => {
  let cause: Cause.Cause<E> = Exit.isFailure(exit) ? exit.cause : Cause.empty;
  let failed = Exit.isFailure(exit);

  for (const cleanup of cleanups) {
    if (Exit.isFailure(cleanup)) {
      cause = Cause.combine(cause, cleanup.cause);
      failed = true;
    }
  }

  return failed ? Exit.failCause(cause) : exit;
};

/**
 * Runs the transaction's code and then closes its scope, in the code's own
 * fiber, so finalizers run where the code ran. A failing finalizer makes
 * the code fail.
 * @param effect - The transaction's code.
 * @param scope - The code's scope.
 * @returns The code's exit combined with the scope's closing.
 */
const runAndCloseScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  scope: Scope.Closeable
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* runTransactionCode() {
      const exit = yield* Effect.exit(restore(effect));
      const closed = yield* Effect.exit(Scope.close(scope, exit));

      return yield* withCleanups(exit, [closed]);
    })
  );

/**
 * Runs the transaction's code in its own fiber. When that fiber ends, every
 * fiber it forked has been interrupted and has ended too; if the caller is
 * interrupted, the fiber is interrupted and awaited. The fiber records its
 * id in `state` before the code runs (see `TransactionState.owns`).
 * @param state - The transaction.
 * @param effect - The transaction's code.
 * @returns Its result.
 */
const isolate = <A, E, R>(
  state: TransactionState,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.forkChild(
    Effect.withFiber((fiber) => {
      state.bodyFiberId = fiber.id;

      return effect;
    })
  ).pipe(
    Effect.flatMap((fiber) =>
      Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
    )
  );

const runActions = (
  actions: readonly Effect.Effect<void>[]
): Effect.Effect<void> =>
  Effect.gen(function* runPostCommitActions() {
    for (const action of actions) {
      // Supervision boundary: an action cannot fail with a typed error,
      // so this sees defects only. The commit already happened, so a
      // defect is logged and the remaining actions still run.
      // Interruption is not caught.
      yield* action.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("Post-commit action failed", Cause.pretty(cause))
        )
      );
    }
  });

const finish = <A, E>(
  state: TransactionState,
  outcome: Outcome<A, E>
): Effect.Effect<A, E | SqlError> => {
  if (outcome._tag === "Committed") {
    return runActions(state.actions).pipe(Effect.as(outcome.value));
  }

  if (outcome._tag === "Poisoned" || outcome._tag === "Refused") {
    const defect =
      outcome._tag === "Refused"
        ? outcome.defect
        : new TransactionRefused({
            detail: outcome.reason,
            reason: "poisoned",
          });

    return Effect.logError(
      "Refused to commit an STD transaction; rolled back",
      defect
    ).pipe(Effect.andThen(Effect.die(defect)));
  }

  return Effect.failCause(outcome.cause);
};

const decodeStart = decodeRows(Schema.Struct({ started: Schema.String }));

const decodeCheck = decodeRows(
  Schema.Struct({
    isolation: Schema.String,
    same_start: Schema.Boolean,
    same_token: Schema.Boolean,
  })
);

/**
 * Marks the transaction: a random token in a transaction-local setting, and
 * its `transaction_timestamp()`. A transaction the code might have started
 * after a hidden `COMMIT` carries neither.
 * @param connection - The reserved connection.
 * @param state - The transaction.
 * @returns An effect that records both in `state`.
 */
const markTransaction = (
  connection: Connection,
  state: TransactionState
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* markTransactionStart() {
    const token = randomUUID();

    const rows = yield* control(
      connection,
      `SELECT set_config('${TRANSACTION_TOKEN_SETTING}', $1, true) AS token,
              transaction_timestamp() AS started`,
      [token]
    );

    const [row] = yield* decodeStart(rows);
    state.token = token;
    state.startedAt = row?.started ?? "";
  });

/**
 * Checks, in one statement right before `COMMIT`, that the session is still
 * in the transaction STD began (same token, same start time) and runs at
 * READ COMMITTED.
 * @param connection - The reserved connection.
 * @param state - The transaction.
 * @returns `undefined` when all holds, otherwise what does not.
 */
const verifyBeforeCommit = (
  connection: Connection,
  state: TransactionState
): Effect.Effect<string | undefined, SqlError> =>
  control(
    connection,
    `SELECT current_setting('${TRANSACTION_TOKEN_SETTING}', true) IS NOT DISTINCT FROM $1 AS same_token,
            transaction_timestamp() = $2::timestamptz AS same_start,
            current_setting('transaction_isolation') AS isolation`,
    [state.token, state.startedAt]
  ).pipe(
    Effect.flatMap(decodeCheck),
    Effect.map(([row]) => {
      if (row === undefined || !row.same_token || !row.same_start) {
        return "the session is no longer in the transaction STD began";
      }

      return row.isolation === isolationOf(state.kind)
        ? undefined
        : `the transaction runs at ${row.isolation}`;
    })
  );

const rollBack = (connection: Connection): Effect.Effect<boolean> =>
  connection.executeRaw("ROLLBACK", []).pipe(
    Effect.as(true),
    // Deliberately the whole cause: after any failed ROLLBACK, a defect or
    // an interruption included, the connection's state is unknown, and
    // `false` makes the caller discard it instead of reusing it.
    Effect.catchCause(() =>
      Effect.logWarning("ROLLBACK failed; the connection is discarded").pipe(
        Effect.as(false)
      )
    )
  );

const commitChecked = <A, E>(
  connection: Connection,
  state: TransactionState,
  value: A
): Effect.Effect<Settled<A, E>> =>
  Effect.gen(function* commitVerified() {
    const verified = yield* Effect.exit(verifyBeforeCommit(connection, state));

    if (Exit.isFailure(verified) || verified.value !== undefined) {
      // The session may be in a transaction the code started; end it and
      // discard the connection either way.
      yield* rollBack(connection);

      const detail = Exit.isFailure(verified)
        ? "the check before COMMIT failed"
        : (verified.value ?? "the check before COMMIT failed");

      return {
        clean: false,
        outcome: {
          _tag: "Refused",
          defect: new TransactionRefused({
            detail,
            reason: "transaction-control",
          }),
        },
      } as const;
    }

    const committed = yield* Effect.exit(commit(connection));

    if (Exit.isFailure(committed)) {
      return {
        clean: false,
        outcome: { _tag: "Failed", cause: committed.cause },
      } as const;
    }

    return committed.value === "ROLLBACK"
      ? ({
          clean: true,
          outcome: {
            _tag: "Poisoned",
            reason: "COMMIT rolled back an aborted transaction",
          },
        } as const)
      : ({ clean: true, outcome: { _tag: "Committed", value } } as const);
  });

const settle = <A, E>(
  connection: Connection,
  state: TransactionState,
  exit: Exit.Exit<A, E | SqlError>
): Effect.Effect<Settled<A, E>> =>
  Effect.gen(function* settleTransaction() {
    if (Exit.isSuccess(exit) && state.poisoned === undefined) {
      return yield* commitChecked<A, E>(connection, state, exit.value);
    }

    const clean = yield* rollBack(connection);

    return Exit.isSuccess(exit)
      ? ({
          clean,
          outcome: { _tag: "Poisoned", reason: state.poisoned ?? "poisoned" },
        } as const)
      : ({ clean, outcome: { _tag: "Failed", cause: exit.cause } } as const);
  });

/**
 * Runs an outermost transaction on `state.client`: reserves a connection,
 * `BEGIN`, `setup`, the caller's `body` in its own fiber and scope, then
 * interrupts every fiber that used the transaction and is still running,
 * checks the session, and `COMMIT`s or `ROLLBACK`s. Every path then closes
 * the transaction; a connection whose transaction could not be ended
 * cleanly is discarded instead of returned to the pool. Post-commit actions
 * run after the connection is released.
 * @param state - Fresh bookkeeping for the transaction.
 * @param setup - Statements after `BEGIN`; its result is passed to `body`.
 * @param body - The caller's code, given the setup result, the checked connection and the scope of the code.
 * @returns The caller's result after commit.
 */
export const runOutermost = <S, A, E, R>(
  state: TransactionState,
  setup: TransactionSetup<S>,
  body: (
    setupResult: S,
    tracked: Connection,
    scope: Scope.Scope
  ) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* runTransaction() {
      const connectionScope = yield* Scope.make();

      const reserved = yield* Effect.exit(
        Scope.provide(state.client.reserve, connectionScope)
      );

      if (Exit.isFailure(reserved)) {
        state.closed = true;
        yield* Scope.close(connectionScope, reserved);

        return yield* Effect.failCause(reserved.cause);
      }

      const connection = reserved.value;
      const tracked = trackConnection(connection, state);
      const bodyScope = yield* Scope.make();
      state.scope = bodyScope;

      const work = Effect.gen(function* transactionWork() {
        yield* control(
          connection,
          state.kind === "diagnostic"
            ? DIAGNOSTIC_BEGIN_STATEMENT
            : BEGIN_STATEMENT
        );

        const setupResult = yield* setup(connection, state).pipe(
          Effect.tapError(state.recordFailure)
        );

        yield* markTransaction(connection, state).pipe(
          Effect.tapError(state.recordFailure)
        );
        state.tracked = tracked;

        return yield* isolate(
          state,
          runAndCloseScope(body(setupResult, tracked, bodyScope), bodyScope)
        );
      });

      const settled = yield* Effect.exit(
        Effect.gen(function* endTransaction() {
          const workExit = yield* Effect.exit(
            restore(work).pipe(
              Effect.provideService(Scope.Scope, connectionScope)
            )
          );

          state.sealed = true;

          const swept = yield* Effect.exit(state.sweepFibers());

          const scopeClosed = yield* Effect.exit(
            Scope.close(bodyScope, workExit)
          );

          return yield* settle(
            connection,
            state,
            withCleanups(workExit, [swept, scopeClosed])
          );
        })
      );

      state.closed = true;

      if (Exit.isFailure(settled) || !settled.value.clean) {
        yield* discardConnection(connection);
      }

      yield* Scope.close(connectionScope, Exit.void);

      if (Exit.isFailure(settled)) {
        return yield* Effect.failCause(settled.cause);
      }

      return yield* finish(state, settled.value.outcome);
    })
  );

/**
 * Runs `effect` inside the running transaction. If it fails after it has
 * written, the transaction is poisoned.
 * @param state - The running transaction.
 * @param effect - The nested unit.
 * @returns The nested unit, unchanged in result and error.
 */
export const joinTransaction = <A, E, R>(
  state: TransactionState,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const before = state.writes;

    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && state.writes > before) {
            state.poison("a nested unit failed after its first write");
          }
        })
      )
    );
  });

/**
 * The running STD transaction, if any.
 * @returns The bookkeeping of the outermost transaction in the fiber's context.
 */
export const currentState: Effect.Effect<Option.Option<TransactionState>> =
  Effect.serviceOption(CurrentTransaction).pipe(
    Effect.map((current) =>
      current.pipe(
        Option.filter(
          (handle): handle is TransactionState =>
            handle instanceof TransactionState
        )
      )
    )
  );

/**
 * Dies unless the requested isolation level is READ COMMITTED.
 * @param isolation - The requested level, if any.
 * @returns A refusal, or `Option.none()`.
 */
export const refuseIsolation = (
  isolation: IsolationLevel | undefined
): Option.Option<Effect.Effect<never>> =>
  isolation === undefined || isolation === REQUEST_ISOLATION
    ? Option.none()
    : Option.some(
        Effect.die(
          new TransactionRefused({
            detail: `isolation level ${isolation}`,
            reason: "isolation-level",
          })
        )
      );

/**
 * Joins a nested unit to the running transaction, re-providing its
 * services, so a joined unit has exactly the context of the outermost one.
 * @param state - The running transaction.
 * @param effect - The nested unit.
 * @returns The unit with its transaction services provided.
 */
export const provideJoined = <A, E, R>(
  state: TransactionState,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, TransactionServices>> => {
  const { configState, scope, tracked } = state;

  if (
    configState === undefined ||
    tracked === undefined ||
    scope === undefined
  ) {
    return Effect.die(
      new TransactionRefused({
        detail: `a request inside a ${state.kind} transaction`,
        reason: "nesting",
      })
    );
  }

  return state
    .enter("joining")
    .pipe(
      Effect.andThen(
        joinTransaction(
          state,
          Effect.provideContext(
            effect,
            transactionContext(state, tracked, scope, configState)
          )
        )
      )
    );
};

/**
 * Runs `effect` as an outermost transaction that provides
 * `TransactionServices`, with the given setup.
 * @param state - Fresh bookkeeping.
 * @param setup - Statements after `BEGIN`, returning the configuration state.
 * @param effect - The caller's code.
 * @returns The caller's result after commit.
 */
export const runAtConfigState = <A, E, R>(
  state: TransactionState,
  setup: TransactionSetup<ConfigState>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, Exclude<R, TransactionServices>> =>
  runOutermost(state, setup, (configState, tracked, scope) => {
    state.configState = configState;

    return Effect.provideContext(
      effect,
      transactionContext(state, tracked, scope, configState)
    );
  });

const beginRequest: TransactionSetup<ConfigState> = (connection) =>
  Effect.gen(function* beginRequestSetup() {
    yield* control(
      connection,
      `SET LOCAL statement_timeout = '${REQUEST_STATEMENT_TIMEOUT}'`
    );
    yield* control(
      connection,
      `SET LOCAL idle_in_transaction_session_timeout = '${REQUEST_IDLE_TIMEOUT}'`
    );
    const rows = yield* control(connection, BEGIN_REQUEST_QUERY);

    return yield* parseConfigState(rows);
  });

const maintenanceSetup =
  (options: MaintenanceOptions | undefined): TransactionSetup<void> =>
  (connection) =>
    Effect.gen(function* beginMaintenanceSetup() {
      if (options?.lockTimeout !== undefined) {
        yield* control(
          connection,
          `SET LOCAL lock_timeout = '${options.lockTimeout}'`
        );
      }

      if (options?.statementTimeout !== undefined) {
        yield* control(
          connection,
          `SET LOCAL statement_timeout = '${options.statementTimeout}'`
        );
      }
    });

const runMaintenance = <A, E, R>(
  client: PgClient.PgClient,
  effect: Effect.Effect<A, E, R>,
  options: MaintenanceOptions | undefined
): Effect.Effect<A, E | SqlError, Exclude<R, MaintenanceServices>> => {
  const state = new TransactionState("maintenance", client);

  return runOutermost(state, maintenanceSetup(options), (_, tracked, scope) =>
    Effect.provideContext(effect, maintenanceContext(state, tracked, scope))
  );
};

/**
 * Starts a request transaction, or joins the running one.
 * @param client - The client a new transaction runs on.
 * @param current - The running transaction, if any.
 * @param effect - The caller's code.
 * @returns The caller's result after commit, or inside the running transaction.
 */
const beginOrJoinRequest = <A, E, R>(
  client: PgClient.PgClient,
  current: Option.Option<TransactionState>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, Exclude<R, TransactionServices>> =>
  Option.isSome(current)
    ? provideJoined(current.value, effect)
    : runAtConfigState(
        new TransactionState("request", client),
        beginRequest,
        effect
      );

const nestedMaintenance = Effect.die(
  new TransactionRefused({
    detail: "a nested maintenance transaction",
    reason: "nesting",
  })
);

const nestedDiagnostic = Effect.die(
  new TransactionRefused({
    detail: "a diagnostic transaction inside another transaction",
    reason: "nesting",
  })
);

// Deparse expression indexes with schema-qualified application functions,
// independently of the database's search_path; restore it when the transaction ends.
const diagnosticSetup: TransactionSetup<void> = Effect.fn(
  "Sql.diagnosticSetup"
)(function* diagnosticSetup(connection: Connection, state: TransactionState) {
  yield* maintenanceSetup({ lockTimeout: DIAGNOSTIC_LOCK_TIMEOUT })(
    connection,
    state
  );
  yield* control(connection, "SET LOCAL search_path = pg_catalog");
});

const runDiagnostic = <A, E, R>(
  client: PgClient.PgClient,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, Exclude<R, MaintenanceServices>> => {
  const state = new TransactionState("diagnostic", client);

  return runOutermost(state, diagnosticSetup, (_, tracked, scope) =>
    Effect.provideContext(effect, maintenanceContext(state, tracked, scope))
  );
};

/** The request and maintenance transactions of one client. */
export interface RequestTransactions {
  /**
   * Runs `effect` in a request transaction, or joins the running
   * transaction when called inside one.
   */
  readonly request: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: RequestOptions
  ) => Effect.Effect<
    A,
    HygienicError<E | SqlError>,
    Exclude<R, TransactionServices>
  >;
  /**
   * Runs `effect` in a plain READ COMMITTED transaction without
   * `begin_request()`, for platform migrations. Cannot be nested.
   */
  readonly maintenance: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: MaintenanceOptions
  ) => Effect.Effect<
    A,
    HygienicError<E | SqlError>,
    Exclude<R, MaintenanceServices>
  >;
  /**
   * Runs `effect` in a REPEATABLE READ READ ONLY transaction without
   * `begin_request()` and without advisory locks, for `doctor`: every
   * statement sees one snapshot, writes are refused by Postgres, and no
   * config commit or schema change is waited for (table reads wait at most
   * `DIAGNOSTIC_LOCK_TIMEOUT`). Cannot be nested.
   */
  readonly diagnostic: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<
    A,
    HygienicError<E | SqlError>,
    Exclude<R, MaintenanceServices>
  >;
}

/**
 * Builds request and maintenance transactions over a client.
 * @param client - The pooled client, or a dedicated single-connection client.
 * @returns The transaction functions.
 */
export const makeRequestTransactions = (
  client: PgClient.PgClient
): RequestTransactions => ({
  diagnostic: Effect.fn("Transactions.diagnostic")(
    function* diagnostic<A, E, R>(effect: Effect.Effect<A, E, R>) {
      const current = yield* currentState;

      return Option.isSome(current)
        ? yield* nestedDiagnostic
        : yield* runDiagnostic(client, effect);
    },
    (effect) => hygienic(effect)
  ),
  maintenance: Effect.fn("Transactions.maintenance")(
    function* maintenance<A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: MaintenanceOptions
    ) {
      const current = yield* currentState;

      return Option.isSome(current)
        ? yield* nestedMaintenance
        : yield* runMaintenance(client, effect, options);
    },
    (effect) => hygienic(effect)
  ),
  request: Effect.fn("Transactions.request")(
    function* request<A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: RequestOptions
    ) {
      const current = yield* currentState;
      const refused = refuseIsolation(options?.isolation);

      return Option.isSome(refused)
        ? yield* refused.value
        : yield* beginOrJoinRequest(client, current, effect);
    },
    (effect) => hygienic(effect)
  ),
});
