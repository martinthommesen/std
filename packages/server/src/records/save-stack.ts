/**
 * The saves enclosing the current one in this transaction (Contracts 4.1):
 * after-write hooks run with the stack extended, so a nested save is
 * refused with `RecordInSave` for a record an enclosing save is saving.
 * The operation ID is transaction-scoped and lives in the transaction (see
 * `change-entry.ts`).
 */
import { Context, Effect } from "effect";

/** The enclosing saves. */
export interface SaveStackValue {
  /** The records the enclosing saves are saving. */
  readonly recordIds: ReadonlySet<string>;
}

/**
 * The enclosing saves of the current fiber. Empty by default: a save
 * outside any other save is the outermost one, which is a real default,
 * not hidden authority.
 */
export const SaveStack = Context.Reference<SaveStackValue>(
  "std/server/SaveStack",
  { defaultValue: () => ({ recordIds: new Set() }) }
);

/**
 * Runs an effect inside a save: with the save's record on the stack.
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
    recordIds: new Set([...stack.recordIds, recordId]),
  });
