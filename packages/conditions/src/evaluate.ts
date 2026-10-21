import { ConditionDefectError } from "./defect.ts";
/**
 * The TypeScript evaluator (Contracts 5.3, 5.4): two-valued, over complete
 * images. On the server conditions run on complete images (an update's
 * proposed image is the stored record merged with the patch), so a field
 * missing from an image, a reference target that was not preloaded, or a
 * context value the resolver could not fill is a defect: it throws
 * `ConditionDefectError` and is never coerced to false.
 *
 * `changed(f)` compares the previous and proposed images under exact stored
 * equality. Pass `previous: null` on create (every previous value is empty,
 * so `changed(f)` is `notEmpty(f)`) and `previous: record` on delete (so
 * `changed` is false).
 */
import { evaluateNode, imageReader } from "./evaluate-core.ts";
import type { ImageSource } from "./evaluate-core.ts";
import type { ResolvedCondition, ResolvedNode } from "./typed.ts";

/**
 * Whether a resolved tree still holds a context value the caller did not
 * provide.
 *
 * @param node - A resolved tree.
 * @returns True when some operand is `unavailable`.
 */
export const hasUnavailableContext = (node: ResolvedNode): boolean => {
  switch (node.op) {
    case "and":
    case "or": {
      return node.args.some((arg) => hasUnavailableContext(arg));
    }

    case "not": {
      return hasUnavailableContext(node.arg);
    }

    case "compare": {
      return node.right.kind === "unavailable";
    }

    case "in": {
      return node.right.some((operand) => operand.kind === "unavailable");
    }

    case "const":
    case "empty":
    case "pattern":
    case "changed": {
      return false;
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Evaluates a resolved condition on complete images.
 *
 * @param condition - The resolved condition.
 * @param source - The record, the previous image for form and record rules,
 *   and the preloaded reference targets (`null` for a target the caller may
 *   not see).
 * @returns Whether the condition holds.
 */
export const evaluateCondition = (
  condition: ResolvedCondition,
  source: ImageSource
): boolean => {
  if (hasUnavailableContext(condition.root)) {
    throw new ConditionDefectError(
      "A context value was not provided to the resolver."
    );
  }

  const verdict = evaluateNode(
    condition.root,
    imageReader(source, {
      missing: (what) => {
        throw new ConditionDefectError(what);
      },
    })
  );

  if (verdict === "unknown") {
    throw new ConditionDefectError("The two-valued evaluator met Unknown.");
  }

  return verdict;
};
