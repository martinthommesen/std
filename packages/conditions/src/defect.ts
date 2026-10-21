/**
 * The error thrown when a caller breaks an evaluator's or the compiler's
 * contract: a field missing from a complete image, a value of the wrong
 * type, a reference target that was not preloaded, or a context value that
 * never reached the resolver. On the server these are defects, never false
 * (Contracts 5.3).
 */

/** A programming error: the caller broke the engine's contract. */
export class ConditionDefectError extends Error {
  override readonly name = "ConditionDefectError";
}
