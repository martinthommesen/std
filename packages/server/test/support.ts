/**
 * Small helpers shared by the server tests.
 */
import { randomUUID } from "node:crypto";

import {
  Cause,
  Duration,
  Effect,
  Exit,
  Option,
  Result,
  Schedule,
} from "effect";
import { SqlClient } from "effect/sql";

import { TransactionRefused } from "../src/sql/transaction-refused.ts";

const POLL_INTERVAL = Duration.millis(20);

/**
 * How long `waitUntil` waits by default: generous, because the condition may
 * depend on a child process starting or on a busy shared Postgres server.
 */
const WAIT_TIMEOUT = Duration.seconds(60);

/**
 * The typed error of a failed exit.
 * @param exit - Any exit.
 * @returns The first typed error, or `undefined`.
 */
export const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    : undefined;

/**
 * The text of the defect of a failed exit.
 * @param exit - Any exit.
 * @returns `String(defect)`, or `undefined` when the exit has no defect.
 */
export const defectTextOf = <A, E>(
  exit: Exit.Exit<A, E>
): string | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }

  const defect = Cause.findDefect(exit.cause);

  return Result.isSuccess(defect) ? String(defect.success) : undefined;
};

/**
 * The `TransactionRefused` defect of a failed exit.
 * @param exit - Any exit.
 * @returns The refusal, or `undefined` when the exit is not one.
 */
export const refusalOf = <A, E>(
  exit: Exit.Exit<A, E>
): TransactionRefused | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }

  const defect = Cause.findDefect(exit.cause);

  return Result.isSuccess(defect) &&
    defect.success instanceof TransactionRefused
    ? defect.success
    : undefined;
};

/**
 * A fresh change set id.
 * @returns A random UUID.
 */
export const changeSetId = (): string => randomUUID();

/**
 * Repeats `check` every 20 ms until it returns `true`; dies after `timeout`.
 * @param check - The condition, usually an observation of Postgres state.
 * @param timeout - How long to wait.
 * @returns Succeeds once the condition holds.
 */
export const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = WAIT_TIMEOUT
): Effect.Effect<void, E, R> =>
  check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(POLL_INTERVAL),
      until: (done) => done,
    }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error("waitUntil timed out")),
    }),
    Effect.asVoid
  );

/**
 * Counts lock waiters in this test's database without changing polling policy.
 * @param options - The original observer's session and wait-event predicates.
 * @returns The number of matching sessions, or the query failure.
 */
export const lockWaiterCount = Effect.fn("Test.lockWaiterCount")(
  function* lockWaiterCount(
    options: { readonly excludeCurrent?: boolean; readonly event?: string } = {}
  ) {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe<{ readonly waiting: string }>(
      `SELECT count(*)::text AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
       ${options.excludeCurrent === true ? "AND pid <> pg_backend_pid()" : ""}
       ${options.event === undefined ? "" : "AND wait_event = $1::text"}`,
      options.event === undefined ? [] : [options.event]
    );

    return Number(rows[0]?.waiting ?? "0");
  }
);
