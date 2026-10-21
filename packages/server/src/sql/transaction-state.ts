/**
 * Bookkeeping of one outermost STD transaction, and the connection wrapper
 * that checks and counts every statement the transaction's code sends.
 */
import type { PgClient } from "@effect/sql-pg";
import { Context, Effect, Fiber, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { SQLSTATE_LOCK_NOT_AVAILABLE, sqlStateOf } from "./errors.ts";
import type { ConfigState } from "./request-revision.ts";
import { analyzeStatement } from "./statement-lexer.ts";
import type { LexedToken } from "./statement-lexer.ts";
import { StatementMarks } from "./statement-marks.ts";
import type { StatementMarksValue } from "./statement-marks.ts";
import { CurrentTransaction } from "./transaction-context.ts";
import type {
  TransactionHandle,
  TransactionKind,
} from "./transaction-context.ts";
import { TransactionRefused } from "./transaction-refused.ts";

/**
 * The first keywords STD runs inside its transactions. An allowlist, not a
 * denylist, so a form nobody thought of is refused rather than admitted:
 *
 * - `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`: reads (and `WITH` writes).
 * - `INSERT`, `UPDATE`, `DELETE`: record writes, journal and ledger rows.
 * - `CREATE`, `ALTER`, `DROP`, `COMMENT`: DDL of change sets and platform
 *   migrations (`CREATE INDEX CONCURRENTLY` fails inside a transaction).
 * - `LOCK`: explicit table locks of the schema engine.
 * - `NOTIFY`, `LISTEN`, `UNLISTEN`: notifications.
 * - `EXPLAIN`, `ANALYZE`: query plans and statistics.
 * - `SET`: only as `SET LOCAL <name> = ...` or `SET LOCAL <name> TO ...`
 *   with `<name>` an unquoted word from `TRANSACTION_SETTINGS`, or from
 *   `READ_TUNING_SETTINGS` followed by exactly one valid value.
 *
 * Everything else is refused, among it `BEGIN`, `START`, `COMMIT`, `END`,
 * `ROLLBACK`, `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE`, `DO`, `CALL`,
 * `RESET`, `DISCARD` and session-level `SET`.
 */
export const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "alter",
  "analyze",
  "comment",
  "create",
  "delete",
  "drop",
  "explain",
  "insert",
  "listen",
  "lock",
  "notify",
  "select",
  "set",
  "show",
  "table",
  "unlisten",
  "update",
  "values",
  "with",
]);

/**
 * The settings the transaction's code may change with `SET LOCAL`: the
 * timeouts (config commits and migrations adjust them).
 */
export const TRANSACTION_SETTINGS: ReadonlySet<string> = new Set([
  "idle_in_transaction_session_timeout",
  "lock_timeout",
  "statement_timeout",
]);

/** Largest value Postgres accepts for `max_parallel_workers_per_gather`. */
const MAX_PARALLEL_WORKERS = 1024;

const DIGITS = /^\d+$/u;

/** The values `plan_cache_mode` takes. */
const PLAN_CACHE_MODES = new Set([
  "auto",
  "force_custom_plan",
  "force_generic_plan",
]);

const isWorkerCount = (value: LexedToken): boolean =>
  value.kind === "other" &&
  DIGITS.test(value.text) &&
  Number(value.text) <= MAX_PARALLEL_WORKERS;

const isPlanCacheMode = (value: LexedToken): boolean =>
  value.kind === "word" && PLAN_CACHE_MODES.has(value.text);

/**
 * Planner settings the transaction's code may change with `SET LOCAL`, each
 * with the exact grammar of its value: an unquoted integer from 0 to 1024
 * for `max_parallel_workers_per_gather`, an unquoted `auto`,
 * `force_custom_plan` or `force_generic_plan` for `plan_cache_mode`. Reads
 * use them to keep rule-branched list queries on custom plans without
 * parallel workers. They change plans only, never results, isolation or
 * locking.
 */
export const READ_TUNING_SETTINGS: ReadonlyMap<
  string,
  (value: LexedToken) => boolean
> = new Map([
  ["max_parallel_workers_per_gather", isWorkerCount],
  ["plan_cache_mode", isPlanCacheMode],
]);

/** `SET LOCAL <name> = <value>`: the tokens of a read-tuning setting. */
const READ_TUNING_TOKENS = 5;

/** First keywords of reads, the only statements `readOnly` may mark. */
export const READ_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "show",
  "table",
  "values",
  "with",
]);

/** Words that suggest a statement changes the transaction's characteristics. */
const ISOLATION_WORDS = new Set([
  "characteristics",
  "isolation",
  "transaction",
  "transaction_isolation",
  "default_transaction_isolation",
]);

const SAVEPOINT_WORDS = new Set(["release", "savepoint"]);

const INSIDE = " inside an STD transaction";

type Refusal = readonly [reason: TransactionRefused["reason"], detail: string];

const CONTROL_REASON = "transaction-control";

const isWord = (token: LexedToken | undefined, text: string): boolean =>
  token?.kind === "word" && token.text === text;

const isAssignment = (token: LexedToken | undefined): boolean =>
  (token?.kind === "other" && token.text === "=") || isWord(token, "to");

const isSetLocal = (tokens: readonly LexedToken[]): boolean => {
  const [first, scope, name, assign, value] = tokens;

  if (
    !isWord(first, "set") ||
    !isWord(scope, "local") ||
    name?.kind !== "word" ||
    !isAssignment(assign)
  ) {
    return false;
  }

  if (TRANSACTION_SETTINGS.has(name.text)) {
    return true;
  }

  const validValue = READ_TUNING_SETTINGS.get(name.text);

  return (
    validValue !== undefined &&
    value !== undefined &&
    tokens.length === READ_TUNING_TOKENS &&
    validValue(value)
  );
};

/**
 * Whether a statement is an admitted `SET LOCAL` of a planner setting
 * (`READ_TUNING_SETTINGS`).
 * @param tokens - The statement's leading tokens.
 * @returns `true` for `SET LOCAL max_parallel_workers_per_gather` or `plan_cache_mode` with a valid value.
 */
const isPlannerSetting = (tokens: readonly LexedToken[]): boolean => {
  const name = tokens.at(2);

  return (
    isSetLocal(tokens) &&
    name !== undefined &&
    READ_TUNING_SETTINGS.has(name.text)
  );
};

/**
 * Why a statement from a transaction's code must not run, if it must not.
 * The text is lexed, so comments, punctuation and quoting cannot hide the
 * first keyword or a second statement; then the statement must be exactly
 * one non-empty statement with no `;` at all, starting with a keyword from
 * `STATEMENT_KEYWORDS`.
 * @param sql - The statement text.
 * @returns The refusal, or `undefined` when the statement may run.
 */
export const refusalFor = (sql: string): Refusal | undefined => {
  const { leadingTokens, separators, statements } = analyzeStatement(sql);

  if (separators > 0 || statements !== 1) {
    return [CONTROL_REASON, "exactly one statement without `;` is allowed"];
  }

  const [first, second] = leadingTokens;
  const keyword = first?.kind === "word" ? first.text : "";

  if (keyword === "set") {
    if (isSetLocal(leadingTokens)) {
      return undefined;
    }

    const isolation = leadingTokens.some(
      (token) => token.kind === "quoted" || ISOLATION_WORDS.has(token.text)
    );

    return [
      isolation ? "isolation-level" : CONTROL_REASON,
      `SET other than SET LOCAL of a timeout or a read-tuning setting with a valid value${INSIDE}`,
    ];
  }

  if (STATEMENT_KEYWORDS.has(keyword)) {
    return undefined;
  }

  if (
    SAVEPOINT_WORDS.has(keyword) ||
    (keyword === "rollback" && second?.kind === "word" && second.text === "to")
  ) {
    return ["savepoint", `${keyword.toUpperCase()}${INSIDE}`];
  }

  return [
    CONTROL_REASON,
    `${keyword === "" ? "this statement" : keyword.toUpperCase()} is not a statement STD runs${INSIDE}`,
  ];
};

const refusal = (
  reason: TransactionRefused["reason"],
  detail: string
): Effect.Effect<never> =>
  Effect.die(new TransactionRefused({ detail, reason }));

/**
 * Mutable bookkeeping of one outermost transaction. It is also the
 * `CurrentTransaction` value, so nested units find it.
 */
export class TransactionState implements TransactionHandle {
  readonly kind: TransactionKind;
  readonly client: PgClient.PgClient;
  /**
   * Statements of the transaction's code that may have written: every one
   * not marked `readOnly`, plus `markWrite` calls.
   */
  writes = 0;
  /** Why the transaction must not commit. */
  poisoned: string | undefined;
  /** Whether a retryable lock wait (the `CONFIG_KEY` wait or `lockWaiting` DDL) timed out. */
  lockTimedOut = false;
  /** Set once `COMMIT` or `ROLLBACK` has run; every later use is refused. */
  closed = false;
  /** The state the transaction runs at, once set up. */
  configState: ConfigState | undefined;
  /** The checked connection the transaction's code uses, once set up. */
  tracked: Connection | undefined;
  /** The scope of the transaction's code, closed before the transaction ends. */
  scope: Scope.Scope | undefined;
  /** Post-commit actions, in registration order. */
  readonly actions: Effect.Effect<void>[] = [];
  /**
   * Every fiber that has used the transaction. Before the commit decision
   * each one still running is interrupted and awaited.
   */
  readonly fibers = new Set<Fiber.Fiber<unknown, unknown>>();
  /** Set when the transaction's code has ended; no new fiber may join. */
  sealed = false;
  /**
   * Id of the fiber that runs the transaction's code. Fiber ids grow
   * monotonically, so a fiber with a smaller id existed before the code
   * started and cannot descend from it.
   */
  bodyFiberId: number | undefined;
  /** Token set with `set_config(..., true)` at the start, checked before `COMMIT`. */
  token = "";
  /** `transaction_timestamp()` at the start, checked before `COMMIT`. */
  startedAt = "";

  /**
   * @param kind - The outermost transaction's kind.
   * @param client - The client the transaction runs on.
   */
  constructor(kind: TransactionKind, client: PgClient.PgClient) {
    this.kind = kind;
    this.client = client;
  }

  readonly afterCommit = (action: Effect.Effect<void>): Effect.Effect<void> =>
    this.enter("afterCommit").pipe(
      Effect.andThen(
        Effect.sync(() => {
          this.actions.push(action);
        })
      )
    );

  readonly markWrite: Effect.Effect<void> = Effect.suspend(() =>
    this.enter("markWrite").pipe(
      Effect.andThen(
        Effect.sync(() => {
          this.writes += 1;
        })
      )
    )
  );

  /**
   * Why `fiber` may not use the transaction now, if it may not. A fiber is
   * recorded on its first use; after the code ended (sealed) only recorded
   * fibers may continue, and after the end nobody may.
   * @param fiber - The fiber asking.
   * @param what - What it attempts.
   * @returns A refusal, or `Option.none()`.
   */
  entryRefusal(
    fiber: Fiber.Fiber<unknown, unknown>,
    what: string
  ): Option.Option<Effect.Effect<never>> {
    if (this.closed) {
      return Option.some(this.closedRefusal(what));
    }

    if (!this.fibers.has(fiber)) {
      if (!this.owns(fiber)) {
        return Option.some(
          refusal(
            "foreignFiber",
            `${what} from a fiber outside the ${this.kind} transaction's code`
          )
        );
      }

      if (this.sealed) {
        return Option.some(
          refusal(
            "foreignFiber",
            `${what} from a fiber that joined after the ${this.kind} transaction's code ended`
          )
        );
      }

      this.fibers.add(fiber);
    }

    return Option.none();
  }

  /**
   * Whether a fiber belongs to the transaction's code: it was created no
   * earlier than the code's own fiber (so it is no ancestor of it) and runs
   * with this transaction as its `CurrentTransaction` (so it was forked from
   * inside the code, or is the code's fiber). Only such fibers are ever
   * enrolled, so the sweep before the commit decision never interrupts a
   * fiber that is waiting for the transaction to end.
   * @param fiber - The fiber asking.
   * @returns `true` when the fiber may enroll.
   */
  owns(fiber: Fiber.Fiber<unknown, unknown>): boolean {
    const current = Context.getOption(fiber.context, CurrentTransaction);

    return (
      this.bodyFiberId !== undefined &&
      fiber.id >= this.bodyFiberId &&
      Option.isSome(current) &&
      current.value === this
    );
  }

  /**
   * Records the current fiber as a user of the transaction, or refuses it.
   * @param what - What it attempts.
   * @returns An effect that admits or refuses.
   */
  enter(what: string): Effect.Effect<void> {
    return Effect.withFiber((fiber) =>
      Option.getOrElse(this.entryRefusal(fiber, what), () => Effect.void)
    );
  }

  /**
   * Interrupts and awaits every recorded fiber that is still running, other
   * than the caller.
   * @returns An effect that ends when they have all ended.
   */
  sweepFibers(): Effect.Effect<void> {
    return Effect.withFiber((current) =>
      Fiber.interruptAll(
        [...this.fibers].filter(
          (fiber) => fiber !== current && fiber.pollUnsafe() === undefined
        )
      )
    );
  }

  readonly poisonReason: Effect.Effect<string | undefined> = Effect.sync(
    () => this.poisoned
  );

  /**
   * The refusal for any use after the transaction ended.
   * @param what - What was attempted.
   * @returns A `TransactionRefused` defect.
   */
  closedRefusal(what: string): Effect.Effect<never> {
    return refusal(
      "closed",
      `${what} after the ${this.kind} transaction ended`
    );
  }

  /**
   * Marks the transaction poisoned; the first reason wins.
   * @param reason - Why it must not commit.
   */
  poison(reason: string): void {
    this.poisoned ??= reason;
  }

  /**
   * Records a failed statement: Postgres has aborted the transaction. A lock
   * timeout is retryable only for statements marked `lockWaiting`.
   * @param failure - The driver error.
   * @param marks - The statement's marks.
   */
  statementFailed(failure: SqlError, marks: StatementMarksValue): void {
    const sqlState = sqlStateOf(failure);

    if (marks.lockWaiting && sqlState === SQLSTATE_LOCK_NOT_AVAILABLE) {
      this.lockTimedOut = true;
    }

    this.poison(`a statement failed with SQLSTATE ${sqlState}`);
  }

  /**
   * `statementFailed` for statements with the given marks, for `tapError`.
   * @param marks - The statements' marks.
   * @returns A function recording a failure.
   */
  readonly failureRecorder =
    (marks: StatementMarksValue) =>
    (failure: SqlError): Effect.Effect<void> =>
      Effect.sync(() => {
        this.statementFailed(failure, marks);
      });

  /**
   * Records that the `CONFIG_KEY` wait timed out (or failed otherwise).
   * @param failure - The driver error of the lock statement.
   * @returns An effect that records it.
   */
  readonly recordLockWaitFailure = (failure: SqlError): Effect.Effect<void> =>
    Effect.sync(() => {
      this.statementFailed(failure, { lockWaiting: true, readOnly: false });
    });

  /**
   * `statementFailed` for the transaction machinery's own statements.
   * @param failure - The driver error.
   * @returns An effect that records the failure.
   */
  readonly recordFailure = (failure: SqlError): Effect.Effect<void> =>
    Effect.sync(() => {
      this.statementFailed(failure, { lockWaiting: false, readOnly: false });
    });

  /**
   * Checks and counts a statement of the transaction's code before it is sent.
   * @param sql - The statement text.
   * @param marks - The statement's marks.
   * @param fiber - The fiber running it.
   * @returns A refusal, or `Option.none()` when the statement may run.
   */
  admit(
    sql: string,
    marks: StatementMarksValue,
    fiber: Fiber.Fiber<unknown, unknown>
  ): Option.Option<Effect.Effect<never>> {
    const entry = this.entryRefusal(fiber, "a statement");

    if (Option.isSome(entry)) {
      return entry;
    }

    const refused = refusalFor(sql);

    if (refused !== undefined) {
      return Option.some(refusal(...refused));
    }

    const lexed = analyzeStatement(sql);

    if (!marks.readOnly) {
      // A planner setting changes plans, never results, so it does not
      // count as a write: a nested unit that only tuned plans may fail
      // without poisoning, even though the setting stays in force for the
      // outer transaction. A timeout setting does count: left behind by a
      // failed nested unit, it would change the outer transaction's
      // deadlines.
      if (!isPlannerSetting(lexed.leadingTokens)) {
        this.writes += 1;
      }

      return Option.none();
    }

    const [first] = lexed.leadingTokens;

    const isRead =
      first?.kind === "word" &&
      READ_KEYWORDS.has(first.text) &&
      !lexed.writeClause;

    return isRead
      ? Option.none()
      : Option.some(
          refusal(
            "transaction-control",
            "readOnly marks a statement that is not a read"
          )
        );
  }
}

/** The marks and fiber of the statement being run. */
interface StatementContext {
  readonly marks: StatementMarksValue;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
}

const statementContext: Effect.Effect<StatementContext> = Effect.withFiber(
  (fiber) =>
    StatementMarks.pipe(
      Effect.map((marks): StatementContext => ({ fiber, marks }))
    )
);

const tracked = <A>(
  state: TransactionState,
  sql: string,
  run: () => Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
  statementContext.pipe(
    Effect.flatMap(({ fiber, marks }) =>
      Option.match(state.admit(sql, marks, fiber), {
        onNone: () => run().pipe(Effect.tapError(state.failureRecorder(marks))),
        onSome: (refused) => refused,
      })
    )
  );

const trackedStream = <A>(
  state: TransactionState,
  sql: string,
  open: () => Stream.Stream<A, SqlError>
): Stream.Stream<A, SqlError> =>
  Stream.unwrap(
    statementContext.pipe(
      Effect.flatMap(({ fiber, marks }) =>
        Option.match(state.admit(sql, marks, fiber), {
          onNone: () =>
            Effect.succeed(
              open().pipe(Stream.tapError(state.failureRecorder(marks)))
            ),
          onSome: (refused) => refused,
        })
      )
    )
  );

/**
 * Wraps a transaction's connection so every statement from the
 * transaction's code is checked and counted, and failures poison it.
 * @param connection - The reserved connection.
 * @param state - The transaction's bookkeeping.
 * @returns The connection the transaction's code uses.
 */
export const trackConnection = (
  connection: Connection,
  state: TransactionState
): Connection => ({
  execute: (sql, params, transformRows) =>
    tracked(state, sql, () => connection.execute(sql, params, transformRows)),
  executeRaw: (sql, params) =>
    tracked(state, sql, () => connection.executeRaw(sql, params)),
  executeStream: (sql, params, transformRows) =>
    trackedStream(state, sql, () =>
      connection.executeStream(sql, params, transformRows)
    ),
  executeUnprepared: (sql, params, transformRows) =>
    tracked(state, sql, () =>
      connection.executeUnprepared(sql, params, transformRows)
    ),
  executeValues: (sql, params) =>
    tracked(state, sql, () => connection.executeValues(sql, params)),
  executeValuesUnprepared: (sql, params) =>
    tracked(state, sql, () => connection.executeValuesUnprepared(sql, params)),
});

const keepRows = <A extends object>(rows: readonly A[]): readonly A[] => rows;

/**
 * Runs one statement of the transaction machinery itself (not counted, not
 * checked).
 * @param connection - The reserved connection.
 * @param sql - The statement.
 * @param params - Its parameters.
 * @returns The rows.
 */
export const control = (
  connection: Connection,
  sql: string,
  params: readonly unknown[] = []
): Effect.Effect<readonly unknown[], SqlError> =>
  connection.execute(sql, params, keepRows);

const CommandResult = Schema.Struct({ command: Schema.String });

const decodeCommandResult = Schema.decodeUnknownOption(CommandResult);

/**
 * Runs `COMMIT` and reports what Postgres did: `COMMIT`, or `ROLLBACK` when
 * the transaction had already been aborted.
 * @param connection - The reserved connection.
 * @returns The command tag Postgres answered with.
 */
export const commit = (
  connection: Connection
): Effect.Effect<string, SqlError> =>
  connection.executeRaw("COMMIT", []).pipe(
    Effect.map((result) =>
      Option.match(decodeCommandResult(result), {
        onNone: () => "COMMIT",
        onSome: (decoded) => decoded.command,
      })
    )
  );
