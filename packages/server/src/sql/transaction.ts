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
 * - Poisoning: when a nested unit fails after its first write, or any
 *   statement in the transaction fails (Postgres has then aborted the
 *   transaction), the transaction is poisoned. A poisoned transaction is
 *   never committed: it is rolled back and dies with a `TransactionRefused`
 *   defect (reason `poisoned`), which is logged, whether or not the caller
 *   handled the original error.
 * - Post-commit actions registered with `CurrentTransaction.afterCommit` run
 *   after the outermost transaction commits and its connection is released;
 *   their failures are logged, not raised.
 * - Driver errors leave as `DatabaseError` (SQLSTATE and constraint only).
 *
 * Writes are counted from the statement text (see `isWriteStatement`). A
 * `SELECT` that writes through a function must call
 * `CurrentTransaction.markWrite`.
 */
import { PgClient } from "@effect/sql-pg";
import { Cause, Context, Effect, Exit, Option } from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { hygienic } from "./errors.ts";
import type { HygienicError } from "./errors.ts";
import { parseConfigState, RequestRevision } from "./request-revision.ts";
import type { ConfigState } from "./request-revision.ts";
import { CurrentTransaction } from "./transaction-context.ts";
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

/** The first query of every request transaction. */
export const BEGIN_REQUEST_QUERY =
  "SELECT revision, change_set_id FROM core.begin_request()";

/** Services a maintenance transaction provides to its code. */
export type MaintenanceServices =
  | CurrentTransaction
  | SqlClient.SqlClient
  | SqlClient.TransactionConnection
  | PgClient.PgClient;

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
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<E | SqlError> };

const maintenanceContext = (
  state: TransactionState,
  tracked: Connection
): Context.Context<MaintenanceServices> =>
  Context.make(CurrentTransaction, state).pipe(
    Context.add(SqlClient.SqlClient, state.client),
    Context.add(PgClient.PgClient, state.client),
    Context.add(state.client.transactionService, [tracked, 0])
  );

const transactionContext = (
  state: TransactionState,
  tracked: Connection,
  configState: ConfigState
): Context.Context<TransactionServices> =>
  maintenanceContext(state, tracked).pipe(
    Context.add(RequestRevision, configState)
  );

const runActions = (
  actions: readonly Effect.Effect<void>[]
): Effect.Effect<void> =>
  Effect.gen(function* runPostCommitActions() {
    for (const action of actions) {
      yield* action.pipe(
        Effect.catchCause((cause) =>
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

  if (outcome._tag === "Poisoned") {
    const defect = new TransactionRefused({
      detail: outcome.reason,
      reason: "poisoned",
    });

    return Effect.logError(
      "Refused to commit a poisoned transaction; rolled back",
      defect
    ).pipe(Effect.andThen(Effect.die(defect)));
  }

  return Effect.failCause(outcome.cause);
};

const settle = <A, E>(
  connection: Connection,
  state: TransactionState,
  exit: Exit.Exit<A, E | SqlError>
): Effect.Effect<Outcome<A, E>> =>
  Effect.gen(function* settleTransaction() {
    if (Exit.isSuccess(exit) && state.poisoned === undefined) {
      const committed = yield* Effect.exit(commit(connection));

      if (Exit.isFailure(committed)) {
        return { _tag: "Failed", cause: committed.cause } as const;
      }

      return committed.value === "ROLLBACK"
        ? ({
            _tag: "Poisoned",
            reason: "COMMIT rolled back an aborted transaction",
          } as const)
        : ({ _tag: "Committed", value: exit.value } as const);
    }

    const rolledBack = yield* Effect.exit(
      connection.executeRaw("ROLLBACK", [])
    );

    if (Exit.isFailure(rolledBack)) {
      yield* Effect.logWarning("ROLLBACK failed; the connection is discarded");
    }

    return Exit.isSuccess(exit)
      ? ({ _tag: "Poisoned", reason: state.poisoned ?? "poisoned" } as const)
      : ({ _tag: "Failed", cause: exit.cause } as const);
  });

/**
 * Runs an outermost transaction on `state.client`: reserves a connection,
 * `BEGIN`, `setup`, the caller's `body`, then `COMMIT` or `ROLLBACK`, and
 * the post-commit actions after the connection is released.
 * @param state - Fresh bookkeeping for the transaction.
 * @param setup - Statements after `BEGIN`; its result is passed to `body`.
 * @param body - The caller's code, given the setup result and the checked connection.
 * @returns The caller's result after commit.
 */
export const runOutermost = <S, A, E, R>(
  state: TransactionState,
  setup: TransactionSetup<S>,
  body: (setupResult: S, tracked: Connection) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* runTransaction() {
        const connection = yield* state.client.reserve;
        const tracked = trackConnection(connection, state);

        const work = Effect.gen(function* transactionWork() {
          yield* control(connection, BEGIN_STATEMENT);

          const setupResult = yield* setup(connection, state).pipe(
            Effect.tapError(state.recordFailure)
          );

          state.tracked = tracked;

          return yield* body(setupResult, tracked);
        });

        const exit = yield* Effect.exit(restore(work));

        return yield* settle(connection, state, exit);
      })
    ).pipe(Effect.flatMap((outcome) => finish(state, outcome)))
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
  const { configState, tracked } = state;

  if (configState === undefined || tracked === undefined) {
    return Effect.die(
      new TransactionRefused({
        detail: `a request inside a ${state.kind} transaction`,
        reason: "nesting",
      })
    );
  }

  return joinTransaction(
    state,
    Effect.provideContext(
      effect,
      transactionContext(state, tracked, configState)
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
  runOutermost(state, setup, (configState, tracked) => {
    state.configState = configState;

    return Effect.provideContext(
      effect,
      transactionContext(state, tracked, configState)
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

  return runOutermost(state, maintenanceSetup(options), (_, tracked) =>
    Effect.provideContext(effect, maintenanceContext(state, tracked))
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
}

/**
 * Builds request and maintenance transactions over a client.
 * @param client - The pooled client, or a dedicated single-connection client.
 * @returns The transaction functions.
 */
export const makeRequestTransactions = (
  client: PgClient.PgClient
): RequestTransactions => ({
  maintenance: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: MaintenanceOptions
  ) =>
    hygienic(
      currentState.pipe(
        Effect.flatMap((current) =>
          Option.isSome(current)
            ? nestedMaintenance
            : runMaintenance(client, effect, options)
        )
      )
    ),
  request: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: RequestOptions
  ) =>
    hygienic(
      currentState.pipe(
        Effect.flatMap((current) =>
          Option.getOrElse(refuseIsolation(options?.isolation), () =>
            beginOrJoinRequest(client, current, effect)
          )
        )
      )
    ),
});
