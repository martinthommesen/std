/**
 * Bookkeeping of one outermost STD transaction, and the connection wrapper
 * that checks and counts every statement the transaction's code sends.
 */
import type { PgClient } from "@effect/sql-pg";
import { Effect, Option, Schema, Stream } from "effect";
import type { Connection } from "effect/sql/SqlConnection";
import type { SqlError } from "effect/sql/SqlError";

import { SQLSTATE_LOCK_NOT_AVAILABLE, sqlStateOf } from "./errors.ts";
import type { ConfigState } from "./request-revision.ts";
import type {
  TransactionHandle,
  TransactionKind,
} from "./transaction-context.ts";
import { TransactionRefused } from "./transaction-refused.ts";

const FIRST_WORD = /^[a-z]+/u;
const ANALYZE_WORD = /\banaly[sz]e\b/u;
const DATA_MODIFYING = /\b(?:insert|update|delete|merge)\b/u;
const WORD_SEPARATOR = /\s+/u;
const HEAD_LENGTH = 512;

const READ_ONLY_WORDS = new Set([
  "fetch",
  "lock",
  "reset",
  "select",
  "set",
  "show",
  "table",
  "values",
]);

const CONTROL_WORDS = new Set([
  "abort",
  "begin",
  "commit",
  "end",
  "prepare",
  "rollback",
  "start",
]);

/**
 * The statement text without leading whitespace and comments, lower-cased
 * and cut to its first `HEAD_LENGTH` characters.
 * @param sql - A statement.
 * @returns Its head.
 */
const statementHead = (sql: string): string => {
  let rest = sql.trimStart();

  while (rest.startsWith("--") || rest.startsWith("/*")) {
    const end = rest.startsWith("--")
      ? rest.indexOf("\n")
      : rest.indexOf("*/") + 1;

    rest = end <= 0 ? "" : rest.slice(end + 1).trimStart();
  }

  return rest.slice(0, HEAD_LENGTH).toLowerCase();
};

const wordsOf = (head: string): readonly string[] =>
  head.split(WORD_SEPARATOR, 4);

/**
 * Whether a statement counts as a write for poisoning: everything except
 * `SELECT`, `SHOW`, `VALUES`, `TABLE`, `FETCH`, `SET`, `RESET`, `LOCK`,
 * `EXPLAIN` without `ANALYZE`, and `WITH` without a data-modifying clause.
 * @param sql - The statement text.
 * @returns `false` for the read-only forms.
 */
export const isWriteStatement = (sql: string): boolean => {
  const head = statementHead(sql);
  const first = FIRST_WORD.exec(head)?.[0] ?? "";

  if (READ_ONLY_WORDS.has(first)) {
    return false;
  }

  if (first === "explain") {
    return ANALYZE_WORD.test(head);
  }

  if (first === "with") {
    return DATA_MODIFYING.test(head);
  }

  return true;
};

const refusal = (
  reason: TransactionRefused["reason"],
  detail: string
): Effect.Effect<never> =>
  Effect.die(new TransactionRefused({ detail, reason }));

/**
 * Checks a statement from a transaction's code before it is sent.
 * @param sql - The statement text.
 * @returns A refusal, or `Option.none()` when the statement may run.
 */
const refusalFor = (sql: string): Option.Option<Effect.Effect<never>> => {
  const head = statementHead(sql);
  const [first = "", second = "", third = ""] = wordsOf(head);

  if (
    first === "savepoint" ||
    first === "release" ||
    (first === "rollback" && second === "to")
  ) {
    return Option.some(
      refusal("savepoint", `${first.toUpperCase()} inside an STD transaction`)
    );
  }

  const setsTransaction =
    first === "set" &&
    (second === "transaction" ||
      (second === "session" && third === "characteristics"));

  if (setsTransaction && head.includes("isolation")) {
    return Option.some(
      refusal("isolation-level", "SET TRANSACTION ISOLATION LEVEL")
    );
  }

  if (CONTROL_WORDS.has(first)) {
    return Option.some(
      refusal(
        "transaction-control",
        `${first.toUpperCase()} inside an STD transaction`
      )
    );
  }

  return Option.none();
};

/**
 * Mutable bookkeeping of one outermost transaction. It is also the
 * `CurrentTransaction` value, so nested units find it.
 */
export class TransactionState implements TransactionHandle {
  readonly kind: TransactionKind;
  readonly client: PgClient.PgClient;
  /** Statements counted as writes so far. */
  writes = 0;
  /** Why the transaction must not commit. */
  poisoned: string | undefined;
  /** Whether a statement failed with `lock_timeout` (SQLSTATE 55P03). */
  lockTimedOut = false;
  /** The state the transaction runs at, once set up. */
  configState: ConfigState | undefined;
  /** The checked connection the transaction's code uses, once set up. */
  tracked: Connection | undefined;
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
    Effect.sync(() => {
      this.actions.push(action);
    });

  readonly markWrite: Effect.Effect<void> = Effect.sync(() => {
    this.writes += 1;
  });

  readonly poisonReason: Effect.Effect<string | undefined> = Effect.sync(
    () => this.poisoned
  );

  /**
   * Marks the transaction poisoned; the first reason wins.
   * @param reason - Why it must not commit.
   */
  poison(reason: string): void {
    this.poisoned ??= reason;
  }

  /**
   * Records a failed statement: Postgres has aborted the transaction.
   * @param failure - The driver error.
   */
  statementFailed(failure: SqlError): void {
    const sqlState = sqlStateOf(failure);

    if (sqlState === SQLSTATE_LOCK_NOT_AVAILABLE) {
      this.lockTimedOut = true;
    }

    this.poison(`a statement failed with SQLSTATE ${sqlState}`);
  }

  /**
   * `statementFailed` as an effect, for `tapError`.
   * @param failure - The driver error.
   * @returns An effect that records the failure.
   */
  readonly recordFailure = (failure: SqlError): Effect.Effect<void> =>
    Effect.sync(() => {
      this.statementFailed(failure);
    });

  /**
   * Checks and counts a statement before it is sent.
   * @param sql - The statement text.
   * @returns A refusal, or `Option.none()` when the statement may run.
   */
  admit(sql: string): Option.Option<Effect.Effect<never>> {
    const refused = refusalFor(sql);

    if (Option.isNone(refused) && isWriteStatement(sql)) {
      this.writes += 1;
    }

    return refused;
  }
}

const tracked = <A>(
  state: TransactionState,
  sql: string,
  run: () => Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
  Effect.suspend(() =>
    Option.match(state.admit(sql), {
      onNone: () => run().pipe(Effect.tapError(state.recordFailure)),
      onSome: (refused) => refused,
    })
  );

const trackedStream = <A>(
  state: TransactionState,
  sql: string,
  open: () => Stream.Stream<A, SqlError>
): Stream.Stream<A, SqlError> =>
  Stream.unwrap(
    Effect.suspend(() =>
      Option.match(state.admit(sql), {
        onNone: () =>
          Effect.succeed(open().pipe(Stream.tapError(state.recordFailure))),
        onSome: (refused) => refused,
      })
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
