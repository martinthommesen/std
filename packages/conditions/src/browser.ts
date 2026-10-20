/**
 * The browser evaluator (Contracts 5.8): three-valued (true, false or
 * `"unknown"`), over partial records. Data is unavailable, and every atom that
 * reads it Unknown, when a field is not in the loaded record, a path's target
 * was not delivered (including a changed reference's new target), a context
 * value was not provided, or proposed text holds code points not assigned in
 * the fold table's Unicode version. `and`, `or` and `not` follow Kleene's
 * rules, which is sound because every atom is total.
 *
 * Null is known data, and so is a field the caller cannot read, which the
 * caller passes as null (it counts as empty, Contracts 5.10). Proposed text
 * goes through steps 1 to 4 of the write conversion (Contracts 5.5) first;
 * text the server would refuse is Unknown, so the server decides.
 *
 * Results are advisory: the browser's clock and time-zone data may differ
 * from the server's, and the server's verdict at save time is binding.
 */
import { isString } from "@std/values/field-value";
import { isFullyAssignedInFoldTableVersion } from "@std/values/fold";
import { convertLongText, convertSingleLineText } from "@std/values/text";

import { evaluateNode, imageReader, UNAVAILABLE } from "./evaluate-core.ts";
import type { Read, RecordImage, Verdict } from "./evaluate-core.ts";
import type { ResolvedCondition, TypedPath } from "./typed.ts";

/** What the browser has loaded. Every image may lack fields. */
export interface PartialSource {
  /** The form's proposed record; text values as typed by the user. */
  readonly record: RecordImage;
  /** The stored record (form rules), or null on create. */
  readonly previous?: RecordImage | null;
  /**
   * Delivered reference targets by record ID; `null` for a target the
   * caller cannot see. A target that is not here is unavailable.
   */
  readonly targets?: ReadonlyMap<string, RecordImage | null>;
}

const convertProposed = (path: TypedPath, value: Read): Read => {
  const { kind } = path.field.type;

  if (!isString(value) || (kind !== "text" && kind !== "longText")) {
    return value;
  }

  if (!isFullyAssignedInFoldTableVersion(value)) {
    return UNAVAILABLE;
  }

  const converted =
    kind === "text" ? convertSingleLineText(value) : convertLongText(value);

  return converted.ok ? converted.value : UNAVAILABLE;
};

/**
 * Evaluates a resolved condition in the browser.
 *
 * @param condition - The resolved condition (form rules arrive simplified
 *   for the caller, see `@std/conditions/simplify`).
 * @param source - The partial record, previous image and delivered targets.
 * @returns True, false, or `"unknown"`: on Unknown the UI marks the field
 *   state pending and asks the form-state endpoint.
 */
export const evaluateInBrowser = (
  condition: ResolvedCondition,
  source: PartialSource
): Verdict =>
  evaluateNode(
    condition.root,
    imageReader(source, {
      missing: () => UNAVAILABLE,
      proposed: convertProposed,
    })
  );
