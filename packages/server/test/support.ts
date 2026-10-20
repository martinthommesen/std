/**
 * Small helpers shared by the server tests.
 */
import { randomUUID } from "node:crypto";

import { Cause, Duration, Effect, Exit, Option, Result } from "effect";

import { TransactionRefused } from "../src/sql/transaction-refused.ts";

const POLL_INTERVAL = Duration.millis(20);

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
 * Polls `check` until it returns `true`, or dies after `timeout`.
 * @param check - The condition.
 * @param timeout - How long to wait.
 * @returns Succeeds once the condition holds.
 */
export const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = Duration.seconds(10)
): Effect.Effect<void, E, R> =>
  Effect.gen(function* pollUntilTrue() {
    const deadline =
      Date.now() + Duration.toMillis(Duration.fromInputUnsafe(timeout));

    let done = yield* check;

    while (!done) {
      if (Date.now() > deadline) {
        return yield* Effect.die(new Error("waitUntil timed out"));
      }

      yield* Effect.sleep(POLL_INTERVAL);
      done = yield* check;
    }

    return yield* Effect.void;
  });
