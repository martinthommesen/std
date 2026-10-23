/**
 * The browser evaluator (Contracts 5.8): three-valued (true, false or
 * `"unknown"`), over partial records. Data is unavailable, and every atom that
 * reads it Unknown, when a field is not in the loaded record, a path's target
 * was not delivered (including a changed reference's new target), a context
 * value was not provided, or text (proposed, previous or a delivered target's)
 * holds code points not assigned in the fold table's Unicode version. `and`,
 * `or` and `not` follow Kleene's rules, which is sound because every atom is
 * total.
 *
 * Null is known data, and so is a field the caller cannot read, which the
 * caller passes as null (it counts as empty, Contracts 5.10). Proposed text
 * goes through steps 1 to 4 of the write conversion (Contracts 5.5) first;
 * text the server would refuse is Unknown, so the server decides.
 *
 * The form-state verdict binds the form (6.3). Callers must use server
 * context for time-sensitive conditions; device time is never authoritative.
 */
import { isString } from "@std/values/field-value";
import { isFullyAssignedInFoldTableVersion } from "@std/values/fold";
import { convertLongText, convertSingleLineText } from "@std/values/text";

import type { Expr, Value, Path } from "./ast.ts";
import { isCompare, isIn, isJunction, isMyGroups } from "./ast.ts";
import { checkCondition } from "./check.ts";
import type { ClassView } from "./class-view.ts";
import { evaluateNode, imageReader, UNAVAILABLE } from "./evaluate-core.ts";
import type { Read, RecordImage, Verdict } from "./evaluate-core.ts";
import { refuseAggregateConstructs } from "./owner-scope.ts";
import type { ConditionContext } from "./resolve.ts";
import { resolveCondition } from "./resolve.ts";
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

// Every text read is checked against the fold table's Unicode version;
// only proposed text (typed by the user) gets the write conversion.
const checkText = (path: TypedPath, value: Read, proposed: boolean): Read => {
  const { kind } = path.field.type;

  if (!isString(value) || (kind !== "text" && kind !== "longText")) {
    return value;
  }

  if (!isFullyAssignedInFoldTableVersion(value)) {
    return UNAVAILABLE;
  }

  if (!proposed) {
    return value;
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
): Verdict => {
  // Owner paths and quantifiers belong to the aggregate evaluator (5.10).
  refuseAggregateConstructs(condition.root);

  return evaluateNode(
    condition.root,
    imageReader(source, {
      missing: () => UNAVAILABLE,
      terminal: checkText,
    })
  );
};

const clockValue = (value: Value | Path): boolean =>
  "rel" in value || ("ctx" in value && value.ctx === "now");

const readsClock = (expression: Expr): boolean => {
  if (expression.op === "inPeriod") {
    return true;
  }

  if (isJunction(expression)) {
    return expression.args.some(readsClock);
  }

  if (expression.op === "not") {
    return readsClock(expression.arg);
  }

  if (isCompare(expression)) {
    return clockValue(expression.right);
  }

  return (
    isIn(expression) &&
    !isMyGroups(expression.right) &&
    expression.right.some(clockValue)
  );
};

/**
 * Evaluates a stored form condition when its schema and context are available; unsupported inputs are Unknown.
 * @param expression - The stored condition.
 * @param options - Available schema, images and server context.
 * @returns The resulting verdict or Unknown.
 */
export const evaluateFormConditionInBrowser = (
  expression: Expr,
  options: {
    readonly classId: string;
    readonly view: ClassView;
    readonly source: PartialSource;
    readonly context?: ConditionContext;
  }
): Verdict => {
  const checked = checkCondition(expression, {
    classId: options.classId,
    profile: "formRule",
    purpose: "evaluate",
    view: options.view,
  });

  if (!checked.ok) {
    return "unknown";
  }

  if (checked.value.root.op === "const") {
    return checked.value.root.value;
  }

  if (options.context === undefined && readsClock(expression)) {
    return "unknown";
  }

  const resolved = resolveCondition(
    checked.value,
    options.context ?? { now: 0, timeZone: "UTC" }
  );

  return resolved.ok
    ? evaluateInBrowser(resolved.value, options.source)
    : "unknown";
};
