/**
 * The saves enclosing the current one in this transaction (Contracts 4.1):
 * after-write hooks run with the stack extended, so a nested save is
 * refused with `RecordInSave` for a record an enclosing save is saving,
 * and with `HookDepthExceeded` once nesting would pass the cap. The
 * operation ID is transaction-scoped and lives in the transaction (see
 * `change-entry.ts`).
 */
import { HookDepthExceeded } from "@std/api/errors/hook-depth-exceeded";
import type { RecordInSave } from "@std/api/errors/record-in-save";
import { Context, Effect, Option } from "effect";

import { CurrentTransaction } from "../sql/transaction-context.ts";

/**
 * The deepest nesting of saves: an outermost save and at most this many
 * saves nested inside it by hooks and record rules (after-commit chains
 * included). [judgment, Contracts 4.1]
 */
export const MAX_HOOK_DEPTH = 8;

/** The enclosing saves. */
export interface SaveStackValue {
  /** The records the enclosing saves are saving. */
  readonly recordIds: ReadonlySet<string>;
  /**
   * How deep a save started here is nested: 0 for an outermost save,
   * n + 1 inside the hooks of a save at depth n. An after-commit effect
   * starts at its cause chain's depth (`after-commit-rules.ts`).
   */
  readonly depth: number;
}

/**
 * The enclosing saves of the current fiber. Empty by default: a save
 * outside any other save is the outermost one, which is a real default,
 * not hidden authority.
 */
export const SaveStack = Context.Reference<SaveStackValue>(
  "std/server/SaveStack",
  { defaultValue: () => ({ depth: 0, recordIds: new Set() }) }
);

/**
 * Runs an effect inside a save: with the save's record on the stack, one
 * level deeper.
 *
 * @param effect - Usually the after-write hooks.
 * @param stack - The stack the save started with.
 * @param recordId - The record the save is saving.
 * @returns The effect with the extended stack.
 */
export const withinSave = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stack: SaveStackValue,
  recordId: string
): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, SaveStack, {
    depth: stack.depth + 1,
    recordIds: new Set([...stack.recordIds, recordId]),
  });

/**
 * Refuses a nested save of hooks or rules: poisons the running
 * transaction first, so the refusal rolls everything back even when hook
 * code catches it. The refused save has written nothing yet, so the
 * nested unit's write counter alone would not poison (Contracts 4.1).
 *
 * @param refusal - `RecordInSave` or `HookDepthExceeded`.
 * @returns Fails with the error.
 */
export const refuseNestedSave = Effect.fn("Records.refuseNestedSave")(
  function* refuseNestedSave(refusal: HookDepthExceeded | RecordInSave) {
    const transaction = yield* CurrentTransaction;

    yield* transaction.refuseCommit(
      `a nested save was refused (${refusal._tag})`
    );

    return yield* refusal;
  }
);

/**
 * Poisons the running transaction when a nested save fails, whatever the
 * failure and whether or not the save wrote anything, including failures
 * before it joins the transaction (an undecodable body). A save is
 * nested when it runs inside another save's hooks or an after-commit
 * effect (`depth > 0`). So hook code that catches a nested save's
 * refusal (a guard, an invariant, validation, an access check) can never
 * commit the saves around it. [judgment, review round 2: stricter than
 * Contracts 4.1's "fails after its first write"] An outermost save, and
 * plain reads, are left alone.
 *
 * @param effect - A record-service write: `createRecord`, `updateRecord`
 *   or `deleteRecord`.
 * @returns The same effect.
 */
export const poisonIfNested = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* nestedSave() {
    const stack = yield* SaveStack;
    const transaction = yield* Effect.serviceOption(CurrentTransaction);

    if (stack.depth === 0 || Option.isNone(transaction)) {
      return yield* effect;
    }

    return yield* effect.pipe(
      Effect.onError(() =>
        transaction.value.refuseCommit("a nested save failed")
      )
    );
  });

/**
 * Refuses a save nested deeper than {@link MAX_HOOK_DEPTH}, poisoning the
 * transaction.
 *
 * @param stack - The stack the save starts with.
 * @returns Fails with `HookDepthExceeded`.
 */
export const checkDepth = (stack: SaveStackValue) =>
  stack.depth > MAX_HOOK_DEPTH
    ? refuseNestedSave(new HookDepthExceeded())
    : Effect.void;
