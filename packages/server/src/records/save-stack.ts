/**
 * The saves enclosing the current one in this transaction (Contracts 4.1):
 * after-write hooks run with the stack extended, so a nested save is
 * refused with `RecordInSave` for a record an enclosing save is saving,
 * and with `HookDepthExceeded` once nesting would pass the cap. The
 * operation ID is transaction-scoped and lives in the transaction (see
 * `change-entry.ts`).
 */
import { HookDepthExceeded } from "@std/api/errors/hook-depth-exceeded";
import { Context, Effect } from "effect";

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
 * Refuses a save nested deeper than {@link MAX_HOOK_DEPTH}.
 *
 * @param stack - The stack the save starts with.
 * @returns Fails with `HookDepthExceeded`.
 */
export const checkDepth = (
  stack: SaveStackValue
): Effect.Effect<void, HookDepthExceeded> =>
  stack.depth > MAX_HOOK_DEPTH
    ? Effect.fail(new HookDepthExceeded())
    : Effect.void;
