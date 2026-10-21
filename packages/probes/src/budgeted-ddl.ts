/**
 * Two ways to run the DDL of a config commit's main transaction
 * (Contracts 1.4 step 2):
 *
 * - `per-statement`: each DDL statement runs under the transaction's
 *   `lock_timeout = '2s'`. Postgres applies `lock_timeout` to each lock
 *   acquisition separately, so a statement or a sequence of statements
 *   that needs several locks can wait far longer than 2 s in one attempt.
 * - `lock-budget`: the 2 s is a budget for the attempt. Before each DDL
 *   statement, every table lock it needs is taken explicitly and one at a
 *   time with `LOCK TABLE <t> IN <mode> MODE`, root first, each under
 *   `SET LOCAL lock_timeout` set to what is left of the budget. The step's
 *   lock list must be complete (`lock-inventory.ts` checks every form), so
 *   the DDL itself never waits for a table lock. A `LOCK TABLE` that times
 *   out raises 55P03 and, marked `lockWaiting`, makes the config commit
 *   retry.
 */
import { MAIN_LOCK_TIMEOUT } from "@std/server/sql/config-commit";
import { lockWaiting } from "@std/server/sql/statement-marks";
import { Duration, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";

import { now, timedMillis } from "./clock.ts";

/** How the DDL of a main transaction waits for locks. */
export type DdlMechanism = "per-statement" | "lock-budget";

/** Table lock modes the main transaction's DDL needs (Contracts 1.4 table). */
export type TableLockMode = "ACCESS EXCLUSIVE" | "SHARE ROW EXCLUSIVE";

/** A table lock a DDL statement takes. */
export interface TableLock {
  readonly table: string;
  readonly mode: TableLockMode;
}

/** One DDL statement and the table locks it takes, root first. */
export interface DdlStep {
  readonly label: string;
  readonly statement: string;
  readonly locks: readonly TableLock[];
}

/** How long one explicit `LOCK TABLE` waited. */
export interface LockWait {
  readonly table: string;
  readonly ms: number;
}

/** One executed step. */
export interface StepTiming {
  readonly label: string;
  /** The DDL statement itself. */
  readonly ms: number;
  /** Explicit locks taken before it (`lock-budget` only). */
  readonly lockWaits: readonly LockWait[];
}

/**
 * A Postgres duration setting such as `200ms` or `2s` in milliseconds.
 * @param setting - The setting.
 * @returns Milliseconds.
 */
export const millisOf = (setting: string): number =>
  setting.endsWith("ms")
    ? Number(setting.slice(0, -"ms".length))
    : Duration.toMillis(Duration.seconds(Number(setting.slice(0, -1))));

/** The DDL lock budget of one attempt, in milliseconds (Contracts 1.4: 2 s). */
export const DDL_LOCK_BUDGET_MS = millisOf(MAIN_LOCK_TIMEOUT);

/** One attempt of a config commit that got past `CONFIG_KEY`. */
export interface AttemptRecord {
  /** When its work started (after `CONFIG_KEY` was granted). */
  readonly startedAt: number;
  /** How long its work ran: a lower bound of how long it held `CONFIG_KEY`. */
  readonly heldMs: number;
  readonly ok: boolean;
}

/** Attempts of one config commit, filled in as they run. */
export interface AttemptLog {
  started: number;
  readonly records: AttemptRecord[];
}

/**
 * A fresh attempt log.
 * @returns An empty log.
 */
export const attemptLog = (): AttemptLog => ({ records: [], started: 0 });

/**
 * Records each run of a config commit's work in `log`.
 * @param log - The attempt log.
 * @param work - The main transaction's work.
 * @returns The same work, recorded.
 */
export const tracked = <A, E, R>(
  log: AttemptLog,
  work: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* recordAttempt() {
    log.started += 1;
    const startedAt = yield* now;
    const exit = yield* Effect.exit(work);
    log.records.push({
      heldMs: (yield* now) - startedAt,
      ok: Exit.isSuccess(exit),
      startedAt,
    });

    return yield* exit;
  });

/** A deadline for the attempt's explicit lock waits. */
export interface LockDeadline {
  /** What is left of the budget, in whole milliseconds, at least 1. */
  readonly remaining: Effect.Effect<number>;
}

/**
 * Starts the lock budget of an attempt.
 * @returns The deadline, `DDL_LOCK_BUDGET_MS` from now.
 */
export const startLockBudget = Effect.gen(function* lockBudget() {
  const deadline = (yield* now) + DDL_LOCK_BUDGET_MS;

  const budget: LockDeadline = {
    remaining: now.pipe(
      Effect.map((time) => Math.max(1, Math.ceil(deadline - time)))
    ),
  };

  return budget;
});

/**
 * Takes a step's table locks explicitly, one at a time, each under
 * `lock_timeout` set to what is left of the budget.
 * @param step - The DDL step.
 * @param budget - The attempt's lock deadline.
 * @returns How long each lock waited.
 */
export const takeStepLocks = (step: DdlStep, budget: LockDeadline) =>
  Effect.gen(function* takeLocks() {
    const sql = yield* SqlClient.SqlClient;
    const waits: LockWait[] = [];

    for (const lock of step.locks) {
      yield* sql.unsafe(
        `SET LOCAL lock_timeout = '${yield* budget.remaining}ms'`
      );

      const [ms] = yield* timedMillis(
        lockWaiting(sql.unsafe(`LOCK TABLE ${lock.table} IN ${lock.mode} MODE`))
      );

      waits.push({ ms, table: lock.table });
    }

    return waits;
  });

/**
 * Runs DDL steps inside a config commit with the given mechanism.
 * @param steps - The statements, in order, with their table locks.
 * @param mechanism - How lock waits are bounded.
 * @returns Per-step timings.
 */
export const runDdlSteps = (
  steps: readonly DdlStep[],
  mechanism: DdlMechanism
) =>
  Effect.gen(function* ddlSteps() {
    const sql = yield* SqlClient.SqlClient;
    const budget = yield* startLockBudget;
    const timings: StepTiming[] = [];

    for (const step of steps) {
      const lockWaits =
        mechanism === "lock-budget" ? yield* takeStepLocks(step, budget) : [];

      const [ms] = yield* timedMillis(lockWaiting(sql.unsafe(step.statement)));

      timings.push({ label: step.label, lockWaits, ms });
    }

    return timings;
  });
