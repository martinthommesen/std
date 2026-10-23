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
import { imageReader, twoValued } from "./evaluate-core.ts";
import type { ImageSource } from "./evaluate-core.ts";
import { refuseAggregateConstructs } from "./owner-scope.ts";
import type { ResolvedCondition } from "./typed.ts";

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
  // Owner paths and quantifiers belong to the aggregate evaluator (5.10).
  refuseAggregateConstructs(condition.root);

  return twoValued(
    condition.root,
    imageReader(source, {
      missing: (what) => {
        throw new ConditionDefectError(what);
      },
    })
  );
};
