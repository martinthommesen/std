/**
 * The saves enclosing the current one in this transaction (Contracts 4.1,
 * 4.2): after-write hooks run with the stack extended, so a nested save
 * joins the outer operation (`operation_id`) and is refused with
 * `RecordInSave` for a record an enclosing save is saving.
 */
import { Context, Effect } from "effect";

/** The enclosing saves. */
export interface SaveStackValue {
  /** The operation of the outermost save; null outside any save. */
  readonly operationId: string | null;
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
  { defaultValue: () => ({ operationId: null, recordIds: new Set() }) }
);

/**
 * Runs an effect inside a save: with the save's record on the stack and
 * its operation as the stack's operation.
 *
 * @param effect - Usually the after-write hooks.
 * @param stack - The stack the save started with.
 * @param save - The save's operation and record.
 * @returns The effect with the extended stack.
 */
export const withinSave = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stack: SaveStackValue,
  save: { readonly operationId: string; readonly recordId: string }
): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, SaveStack, {
    operationId: save.operationId,
    recordIds: new Set([...stack.recordIds, save.recordId]),
  });
