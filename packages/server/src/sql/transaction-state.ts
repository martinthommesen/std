/**
 * Bookkeeping of one outermost STD transaction, and the connection wrapper
 * that checks and counts every statement the transaction's code sends.
 */
import type { PgClient } from "@effect/sql-pg";
import { Effect, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { SQLSTATE_LOCK_NOT_AVAILABLE, sqlStateOf } from "./errors.ts";
import type { ConfigState } from "./request-revision.ts";
import { analyzeStatement } from "./statement-lexer.ts";
import { StatementMarks } from "./statement-marks.ts";
import type { StatementMarksValue } from "./statement-marks.ts";
import type {
  TransactionHandle,
  TransactionKind,
} from "./transaction-context.ts";
import { TransactionRefused } from "./transaction-refused.ts";

/** Leading words that end, nest or replace a transaction. */
const CONTROL_WORDS = new Set([
  "abort",
  "begin",
  "commit",
  "end",
  "rollback",
  "start",
]);

/** Leading words that manage savepoints. */
const SAVEPOINT_WORDS = new Set(["release", "savepoint"]);

/** Settings that change a transaction's characteristics. */
const TRANSACTION_SETTINGS = new Set([
  "default_transaction_deferrable",
  "default_transaction_isolation",
  "default_transaction_read_only",
  "transaction_deferrable",
  "transaction_isolation",
  "transaction_read_only",
]);

/** Modifiers between `SET` and the setting's name. */
const SET_SCOPES = new Set(["local", "session"]);

type Refusal = readonly [reason: TransactionRefused["reason"], detail: string];

const ISOLATION_LEVEL = "isolation-level";
const TRANSACTION_CONTROL = "transaction-control";

const refuseSet = (words: readonly string[]): Refusal | undefined => {
  const [, second = "", third = ""] = words;
  const name = SET_SCOPES.has(second) ? third : second;

  if (name === "transaction") {
    return [ISOLATION_LEVEL, "SET TRANSACTION inside an STD transaction"];
  }

  if (second === "session" && third === "characteristics") {
    return [
      ISOLATION_LEVEL,
      "SET SESSION CHARACTERISTICS inside an STD transaction",
    ];
  }

  if (TRANSACTION_SETTINGS.has(name)) {
    return [ISOLATION_LEVEL, `SET ${name} inside an STD transaction`];
  }

  return undefined;
};

/**
 * Why a statement from a transaction's code must not run, if it must not.
 * The text is lexed, so comments, punctuation and quoting cannot hide the
 * first keyword or a second statement.
 * @param sql - The statement text.
 * @returns The refusal, or `undefined` when the statement may run.
 */
export const refusalFor = (sql: string): Refusal | undefined => {
  const { leadingWords, statements } = analyzeStatement(sql);
  const [first = "", second = ""] = leadingWords;

  if (statements > 1) {
    return [TRANSACTION_CONTROL, "several statements in one text"];
  }

  if (SAVEPOINT_WORDS.has(first) || (first === "rollback" && second === "to")) {
    return ["savepoint", `${first.toUpperCase()} inside an STD transaction`];
  }

  if (
    CONTROL_WORDS.has(first) ||
    (first === "prepare" && second === "transaction")
  ) {
    return [
      TRANSACTION_CONTROL,
      `${first.toUpperCase()} inside an STD transaction`,
    ];
  }

  if (first === "set") {
    return refuseSet(leadingWords);
  }

  if (
    first === "reset" &&
    (second === "all" || TRANSACTION_SETTINGS.has(second))
  ) {
    return [TRANSACTION_CONTROL, `RESET ${second} inside an STD transaction`];
  }

  return undefined;
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
   * @param kind - The outermost transaction's kind.
   * @param client - The client the transaction runs on.
   */
  constructor(kind: TransactionKind, client: PgClient.PgClient) {
    this.kind = kind;
    this.client = client;
  }

  readonly afterCommit = (action: Effect.Effect<void>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (this.closed) {
        return this.closedRefusal("afterCommit");
      }

      this.actions.push(action);

      return Effect.void;
    });

  readonly markWrite: Effect.Effect<void> = Effect.suspend(() => {
    if (this.closed) {
      return this.closedRefusal("markWrite");
    }

    this.writes += 1;

    return Effect.void;
  });

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
   * @returns A refusal, or `Option.none()` when the statement may run.
   */
  admit(
    sql: string,
    marks: StatementMarksValue
  ): Option.Option<Effect.Effect<never>> {
    if (this.closed) {
      return Option.some(this.closedRefusal("a statement"));
    }

    const refused = refusalFor(sql);

    if (refused !== undefined) {
      return Option.some(refusal(...refused));
    }

    if (!marks.readOnly) {
      this.writes += 1;
    }

    return Option.none();
  }
}

const tracked = <A>(
  state: TransactionState,
  sql: string,
  run: () => Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
  StatementMarks.pipe(
    Effect.flatMap((marks) =>
      Option.match(state.admit(sql, marks), {
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
    StatementMarks.pipe(
      Effect.flatMap((marks) =>
        Option.match(state.admit(sql, marks), {
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
