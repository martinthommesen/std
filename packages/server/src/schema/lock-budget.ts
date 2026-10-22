/**
 * The per-attempt lock budget of a config commit's DDL (Contracts 1.4 step
 * 2, decision 0007): every table lock a statement needs is taken
 * explicitly, one at a time, root first, each after setting
 * `lock_timeout` to what is left of the budget; then `lock_timeout` is set
 * to the remainder once more and the statement runs. Both are marked
 * `lockWaiting`, so a lock timeout rolls the attempt back and the config
 * commit retries it.
 */
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";

import { MAIN_LOCK_TIMEOUT } from "../sql/config-commit.ts";
import { lockWaiting } from "../sql/statement-marks.ts";
import type { DdlStatement, TableLock } from "./ddl-forms.ts";

/**
 * The time one attempt of a main transaction may spend waiting for table
 * locks, across all its DDL statements (Contracts 1.4). Postgres's
 * `lock_timeout` applies per lock, so a fixed 2 s would let an attempt that
 * waits on two ancestors in turn hold `CONFIG_KEY` for twice that.
 */
export const DDL_LOCK_BUDGET_MS = 2000;

/** The lock-wait budget of one main-transaction attempt. */
export interface LockBudget {
  readonly deadline: number;
}

const remainingMs = (budget: LockBudget): Effect.Effect<number> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => Math.max(1, budget.deadline - now))
  );

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
export const takeTableLocks = Effect.fn("Schema.takeTableLocks")(
  function* takeTableLocks(locks: readonly TableLock[]) {
    const sql = yield* SqlClient.SqlClient;

    const budget: LockBudget = {
      deadline: (yield* Clock.currentTimeMillis) + DDL_LOCK_BUDGET_MS,
    };

    for (const lock of locks) {
      const remaining = yield* remainingMs(budget);

      yield* sql.unsafe(`SET LOCAL lock_timeout = '${remaining}ms'`);
      yield* lockWaiting(
        sql.unsafe(`LOCK TABLE ${lock.table} IN ${lock.mode} MODE`)
      );
    }

    return budget;
  }
);

/**
 * Runs DDL whose table locks are already held. `lock_timeout` stays at what
 * is left of the budget (at least 1 ms), so a lock missing from the
 * inventory fails fast as a retryable lock timeout instead of waiting.
 *
 * @param statements - The statements, in order.
 * @param budget - The attempt's budget.
 * @returns An effect in the main transaction.
 */
export const runDdl = Effect.fn("Schema.runDdl")(function* runDdl(
  statements: readonly DdlStatement[],
  budget: LockBudget
) {
  const sql = yield* SqlClient.SqlClient;

  for (const statement of statements) {
    const remaining = yield* remainingMs(budget);

    yield* sql.unsafe(`SET LOCAL lock_timeout = '${remaining}ms'`);
    yield* lockWaiting(sql.unsafe(statement.sql));
  }
});

/** Sets `lock_timeout` back to the main transaction's 2 s after the DDL. */
export const restoreLockTimeout = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) =>
    sql.unsafe(`SET LOCAL lock_timeout = '${MAIN_LOCK_TIMEOUT}'`)
  )
);
