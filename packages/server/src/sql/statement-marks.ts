/**
 * Explicit marks on statements run inside an STD transaction.
 *
 * The transaction layer never infers what a statement does from its text.
 * By default every statement the transaction's code runs counts as a
 * potential write (so a nested unit that fails after it is poisoned) and a
 * lock timeout it raises is not retried. Code that constructs a statement
 * itself and knows better says so:
 *
 * - `readOnly(statement)`: the statement only reads. A nested unit whose
 *   statements were all marked read-only may fail without poisoning the
 *   transaction. Mark only statements you built as plain reads; a `SELECT`
 *   that calls a writing function is not one.
 * - `lockWaiting(statement)`: the statement is DDL run under the config
 *   commit's 2 s `lock_timeout`, so its lock timeout (SQLSTATE 55P03) makes
 *   the config commit roll back and retry (Contracts 1.4).
 */
import { Context, Effect } from "effect";

/** The marks of the statements an effect runs. */
export interface StatementMarksValue {
  readonly readOnly: boolean;
  readonly lockWaiting: boolean;
}

/** No marks: a potential write whose lock timeout is not retried. */
export const NO_STATEMENT_MARKS: StatementMarksValue = {
  lockWaiting: false,
  readOnly: false,
};

/** The marks in effect for the statements of the current fiber. */
export const StatementMarks = Context.Reference<StatementMarksValue>(
  "@std/server/sql/statement-marks/StatementMarks",
  { defaultValue: () => NO_STATEMENT_MARKS }
);

const withMark = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  mark: Partial<StatementMarksValue>
): Effect.Effect<A, E, R> =>
  StatementMarks.pipe(
    Effect.flatMap((marks) =>
      Effect.provideService(effect, StatementMarks, { ...marks, ...mark })
    )
  );

/**
 * Marks the statements of `effect` as reads.
 * @param effect - Usually one statement the caller built as a plain `SELECT`.
 * @returns The same effect.
 */
export const readOnly = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => withMark(effect, { readOnly: true });

/**
 * Marks the statements of `effect` as DDL waiting for table locks under the
 * config commit's `lock_timeout`, whose timeout is retried.
 * @param effect - Usually one DDL statement of a config commit.
 * @returns The same effect.
 */
export const lockWaiting = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => withMark(effect, { lockWaiting: true });
