/**
 * The checker (Contracts 5.2, 5.4, 5.10): checks a condition against a class
 * and a profile and returns the {@link CheckedCondition} the resolver,
 * evaluators and SQL compiler work on.
 *
 * It checks that field IDs exist on the class (and on each reference's
 * target class), are readable where the view says so, and are not retired
 * when the condition is being stored or edited (`purpose: "store"`); that
 * operators fit the field type and the profile; that `previous`, context
 * values and path hops are allowed by the profile; that a right-hand path is
 * used only by `eq` to `ge` and stays in the left field's comparison class;
 * and that literals convert under the field type's rules
 * (`@std/values/literal`): a text literal converting to empty is refused with
 * a hint to use `empty`, `in` lists hold at most 1,000 elements, `contains`
 * refuses an empty needle, and password and secret allow only `empty` and
 * `notEmpty`. Every problem is reported, each with its path into the AST.
 */
import { comparableValue } from "@std/values/compare";
import type { InvalidValue } from "@std/values/field-error";
import { comparisonClass } from "@std/values/field-type";
import type { ConditionProfile, FieldKind } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { convertLiteral, convertNeedleLiteral } from "@std/values/literal";

import {
  decodeExpr,
  exprDepth,
  isExpr,
  MAX_CONDITION_DEPTH,
  isCompare,
  isEmptyTest,
  isIn,
  isJunction,
  isMyGroups,
  isPath,
  isPatternTest,
} from "./ast.ts";
import type {
  AtomOperator,
  Changed,
  Compare,
  Empty,
  Expr,
  In,
  InPeriod,
  LiteralValue,
  Path,
  Pattern,
  Value,
} from "./ast.ts";
import type { ClassView, FieldInfo } from "./class-view.ts";
import { invalid, issue, valid } from "./issue.ts";
import type {
  AstPathSegment,
  ConditionIssue,
  ConditionResult,
} from "./issue.ts";
import {
  operatorFitsKind,
  profileAllowsOperator,
  profileRules,
} from "./profile.ts";
import type { ContextName, ProfileOptions, ProfileRules } from "./profile.ts";
import { makeChecked } from "./typed.ts";
import type {
  CheckedCondition,
  CheckedNode,
  CheckedOperand,
  PositiveCompare,
  TypedPath,
} from "./typed.ts";

/** The most elements an `in` list may hold (Contracts 5.2). */
export const IN_LIST_MAX_ELEMENTS = 1000;

/** The largest absolute offset of a relative date or period. [judgment] */
export const MAX_RELATIVE_OFFSET = 100_000;

const tooDeep = issue(
  "tooDeep",
  [],
  `Conditions nest at most ${MAX_CONDITION_DEPTH} levels.`
);

const notAnAst = issue(
  "malformed",
  [],
  "The value is not a condition AST (Contracts 5.2)."
);

/** What the checker checks against. */
export interface CheckOptions {
  /** The classes and fields the condition may name. */
  readonly view: ClassView;
  /** The class the condition applies to (the endpoint's or rule's class). */
  readonly classId: string;
  /** The profile. */
  readonly profile: ConditionProfile;
  /** Stage options (`myGroups`, access-rule hops). */
  readonly profileOptions?: ProfileOptions;
  /**
   * `store` when a condition is stored or edited: retired fields are
   * refused. `evaluate` for stored conditions about to run: retired fields
   * keep working, since their columns still exist (Contracts 5.2).
   */
  readonly purpose: "store" | "evaluate";
  /**
   * Form rules: whether the form preloads a path. Paths with hops that are
   * not preloaded are refused. Omitted: every path within the hop limit.
   */
  readonly isPreloaded?: (path: readonly string[]) => boolean;
  /**
   * Record-rule action conditions (`forEach.where`, Contracts 4.10): the
   * class of the rule's own record. Only then may the right side of `eq`
   * to `ge` be a `scope: "record"` path: one field of that record, or an
   * empty path for its ID (compared with a reference or uuid field).
   * Omitted: every scoped path is refused.
   */
  readonly recordClassId?: string;
}

interface Checker {
  readonly options: CheckOptions;
  readonly rules: ProfileRules;
  readonly issues: ConditionIssue[];
}

type Segments = readonly AstPathSegment[];

const literalIssue = (error: InvalidValue, at: Segments): ConditionIssue => {
  if (error.reason === "emptyLiteral") {
    return issue(
      "emptyLiteral",
      at,
      error.message,
      error.hint ?? "Use the empty operator to match empty values."
    );
  }

  if (error.reason === "emptyNeedle") {
    return issue("emptyNeedle", at, error.message);
  }

  return error.hint === undefined
    ? issue("invalidLiteral", at, error.message)
    : issue("invalidLiteral", at, error.message, error.hint);
};

const checkPathLimits = (
  checker: Checker,
  path: Path,
  at: Segments
): boolean => {
  const { rules, options } = checker;
  const hops = path.path.length - 1;

  if (path.path.length === 0) {
    checker.issues.push(
      issue("emptyPath", [...at, "path"], "A path names at least one field.")
    );

    return false;
  }

  if (path.image === "previous" && !rules.previous) {
    checker.issues.push(
      issue(
        "previousNotAllowed",
        [...at, "image"],
        `The ${rules.profile} profile cannot read the previous image.`
      )
    );
  }

  if (hops > rules.maxHops) {
    checker.issues.push(
      issue(
        "tooManyHops",
        [...at, "path"],
        `The ${rules.profile} profile follows at most ${rules.maxHops} reference hop(s).`
      )
    );

    return false;
  }

  if (
    hops > 0 &&
    rules.profile === "formRule" &&
    options.isPreloaded !== undefined &&
    !options.isPreloaded(path.path)
  ) {
    checker.issues.push(
      issue(
        "pathNotPreloaded",
        [...at, "path"],
        "Form rules may follow only paths the form preloads."
      )
    );

    return false;
  }

  return true;
};

const resolveHop = (
  checker: Checker,
  classId: string,
  fieldId: string,
  at: Segments
): FieldInfo | undefined => {
  const { view, purpose } = checker.options;
  const field = view.field(classId, fieldId);
  const readable = view.canRead?.(classId, fieldId) ?? true;

  if (field === undefined || !readable) {
    checker.issues.push(
      issue("unknownField", at, "No such field on this class.")
    );

    return undefined;
  }

  if (purpose === "store" && field.retired) {
    checker.issues.push(
      issue(
        "retiredField",
        at,
        "This field is retired; new conditions cannot use it."
      )
    );
  }

  return field;
};

const typePath = (
  checker: Checker,
  path: Path,
  at: Segments
): TypedPath | undefined => {
  if (path.scope !== undefined) {
    checker.issues.push(
      issue(
        "scopeNotAllowed",
        [...at, "scope"],
        "A record-scoped path may stand only on the right of a comparison."
      )
    );

    return undefined;
  }

  if (!checkPathLimits(checker, path, at)) {
    return undefined;
  }

  const fields: FieldInfo[] = [];
  const classes: string[] = [];
  let classId: string = checker.options.classId;

  for (const [index, fieldId] of path.path.entries()) {
    const field = resolveHop(checker, classId, fieldId, [...at, "path", index]);

    if (field === undefined) {
      return undefined;
    }

    fields.push(field);
    classes.push(classId);

    if (index < path.path.length - 1) {
      if (field.type.kind !== "reference") {
        checker.issues.push(
          issue(
            "notAReference",
            [...at, "path", index],
            "Only reference fields can be followed."
          )
        );

        return undefined;
      }

      classId = field.type.targetClassId;
    }
  }

  const [field] = fields.slice(-1);

  return field === undefined
    ? undefined
    : {
        classes,
        field,
        fields,
        ids: path.path,
        image: path.image === "previous" ? "previous" : "current",
      };
};

const requireContext = (
  checker: Checker,
  name: ContextName,
  at: Segments
): boolean => {
  if (checker.rules.context.has(name)) {
    return true;
  }

  checker.issues.push(
    issue(
      "contextNotAllowed",
      at,
      `The ${checker.rules.profile} profile cannot use ${name}.`
    )
  );

  return false;
};

const requireKind = (
  checker: Checker,
  kind: FieldKind,
  allowed: readonly FieldKind[],
  at: Segments,
  what: string,
  hint?: string
): boolean => {
  if (allowed.includes(kind)) {
    return true;
  }

  checker.issues.push(
    hint === undefined
      ? issue("contextNotForType", at, `${what} does not fit this field type.`)
      : issue(
          "contextNotForType",
          at,
          `${what} does not fit this field type.`,
          hint
        )
  );

  return false;
};

const checkOffset = (
  checker: Checker,
  offset: number,
  at: Segments
): boolean => {
  if (Number.isSafeInteger(offset) && Math.abs(offset) <= MAX_RELATIVE_OFFSET) {
    return true;
  }

  checker.issues.push(
    issue(
      "offsetOutOfRange",
      [...at, "offset"],
      `Offsets are whole numbers of at most ${MAX_RELATIVE_OFFSET} units.`
    )
  );

  return false;
};

const ID_KINDS: readonly FieldKind[] = ["reference", "uuid"];

const typeLiteral = (
  checker: Checker,
  field: FieldInfo,
  json: LiteralValue,
  at: Segments
): CheckedOperand | undefined => {
  const converted = convertLiteral(
    field.type.kind,
    json.value,
    field.choices === undefined ? {} : { choices: field.choices }
  );

  if (!converted.ok) {
    checker.issues.push(literalIssue(converted.error, [...at, "value"]));

    return undefined;
  }

  const value = comparableValue(field.type, converted.value);

  if (value === undefined) {
    checker.issues.push(
      issue(
        "invalidLiteral",
        [...at, "value"],
        "This field type has no literal comparisons."
      )
    );

    return undefined;
  }

  return { kind: "literal", value };
};

const typeValue = (
  checker: Checker,
  field: FieldInfo,
  value: Value,
  at: Segments
): CheckedOperand | undefined => {
  const { kind } = field.type;

  if ("value" in value) {
    return typeLiteral(checker, field, value, at);
  }

  if ("ctx" in value) {
    if (value.ctx === "me") {
      const fits =
        requireContext(checker, "me", at) &&
        requireKind(checker, kind, ID_KINDS, at, "me");

      return fits ? { kind: "me" } : undefined;
    }

    const fits =
      requireContext(checker, "now", at) &&
      requireKind(
        checker,
        kind,
        ["dateTime"],
        at,
        "now",
        "Use today for date fields."
      );

    return fits ? { kind: "now" } : undefined;
  }

  const allowed: readonly FieldKind[] =
    value.rel === "now" ? ["dateTime"] : ["date", "dateTime"];

  const fits =
    requireContext(checker, "now", at) &&
    requireKind(
      checker,
      kind,
      allowed,
      at,
      value.rel,
      value.rel === "now" ? "Use today for date fields." : undefined
    ) &&
    checkOffset(checker, value.offset, at);

  if (!fits) {
    return undefined;
  }

  return value.rel === "now"
    ? { kind: "relNow", offset: value.offset, unit: value.unit }
    : { kind: "relToday", offset: value.offset, unit: value.unit };
};

const checkOperator = (
  checker: Checker,
  operator: AtomOperator,
  kind: FieldKind,
  at: Segments
): boolean => {
  if (!profileAllowsOperator(checker.rules, operator)) {
    checker.issues.push(
      issue(
        "operatorNotAllowed",
        [...at, "op"],
        `The ${checker.rules.profile} profile cannot use ${operator}.`
      )
    );

    return false;
  }

  if (!operatorFitsKind(operator, kind)) {
    const writeOnly = kind === "password" || kind === "secret";

    checker.issues.push(
      writeOnly
        ? issue(
            "operatorNotForType",
            [...at, "op"],
            `${operator} does not apply to this field type.`,
            "Password and secret fields allow only empty and notEmpty."
          )
        : issue(
            "operatorNotForType",
            [...at, "op"],
            `${operator} does not apply to this field type.`
          )
    );

    return false;
  }

  return true;
};

const typeRecordPath = (
  checker: Checker,
  left: TypedPath,
  path: Path,
  at: Segments
): CheckedOperand | undefined => {
  const { recordClassId } = checker.options;

  if (recordClassId === undefined) {
    checker.issues.push(
      issue(
        "scopeNotAllowed",
        [...at, "scope"],
        `The ${checker.rules.profile} profile cannot read a rule's own record here.`
      )
    );

    return undefined;
  }

  if (path.image !== undefined) {
    checker.issues.push(
      issue(
        "previousNotAllowed",
        [...at, "image"],
        "A record-scoped path reads the rule's record as it is saved."
      )
    );

    return undefined;
  }

  const [fieldId, ...rest] = path.path;

  if (fieldId === undefined) {
    return requireKind(
      checker,
      left.field.type.kind,
      ID_KINDS,
      at,
      "The record's ID"
    )
      ? { field: null, kind: "record" }
      : undefined;
  }

  if (rest.length > 0) {
    checker.issues.push(
      issue(
        "tooManyHops",
        [...at, "path"],
        "A record-scoped path names one field of the rule's record."
      )
    );

    return undefined;
  }

  const field = resolveHop(checker, recordClassId, fieldId, [...at, "path", 0]);

  if (field === undefined) {
    return undefined;
  }

  if (
    comparisonClass(field.type.kind) !== comparisonClass(left.field.type.kind)
  ) {
    checker.issues.push(
      issue(
        "comparisonClassMismatch",
        at,
        "Both sides must be in the same comparison class."
      )
    );

    return undefined;
  }

  return { field, kind: "record" };
};

const negateIf = (negated: boolean, node: CheckedNode): CheckedNode =>
  negated ? { arg: node, op: "not" } : node;

const typeCompare = (
  checker: Checker,
  expr: Compare,
  at: Segments
): CheckedNode | undefined => {
  const left = typePath(checker, expr.left, [...at, "left"]);

  if (left === undefined) {
    return undefined;
  }

  const { kind } = left.field.type;

  if (!checkOperator(checker, expr.op, kind, at)) {
    return undefined;
  }

  let right: CheckedOperand | undefined;

  if (isPath(expr.right) && expr.right.scope === "record") {
    right = typeRecordPath(checker, left, expr.right, [...at, "right"]);
  } else if (isPath(expr.right)) {
    const path = typePath(checker, expr.right, [...at, "right"]);

    if (path === undefined) {
      return undefined;
    }

    if (comparisonClass(path.field.type.kind) !== comparisonClass(kind)) {
      checker.issues.push(
        issue(
          "comparisonClassMismatch",
          [...at, "right"],
          "Both sides must be in the same comparison class."
        )
      );

      return undefined;
    }

    right = { kind: "path", path };
  } else {
    right = typeValue(checker, left.field, expr.right, [...at, "right"]);
  }

  if (right === undefined) {
    return undefined;
  }

  const compare: PositiveCompare = expr.op === "ne" ? "eq" : expr.op;

  return negateIf(expr.op === "ne", {
    compare,
    left,
    op: "compare",
    right,
  });
};

const typeIn = (
  checker: Checker,
  expr: In,
  at: Segments
): CheckedNode | undefined => {
  const left = typePath(checker, expr.left, [...at, "left"]);

  if (
    left === undefined ||
    !checkOperator(checker, expr.op, left.field.type.kind, at)
  ) {
    return undefined;
  }

  let right: CheckedOperand[] | undefined;

  if (isMyGroups(expr.right)) {
    const fits =
      requireContext(checker, "myGroups", [...at, "right"]) &&
      requireKind(
        checker,
        left.field.type.kind,
        ID_KINDS,
        [...at, "right"],
        "myGroups"
      );

    right = fits ? [{ kind: "myGroups" }] : undefined;
  } else if (expr.right.length > IN_LIST_MAX_ELEMENTS) {
    checker.issues.push(
      issue(
        "tooManyElements",
        [...at, "right"],
        `in lists hold at most ${IN_LIST_MAX_ELEMENTS} elements.`
      )
    );
  } else {
    const operands = expr.right.map((value, index) =>
      typeValue(checker, left.field, value, [...at, "right", index])
    );

    right = operands.every((operand) => operand !== undefined)
      ? operands.filter((operand) => operand !== undefined)
      : undefined;
  }

  return right === undefined
    ? undefined
    : negateIf(expr.op === "notIn", { left, op: "in", right });
};

const typePattern = (
  checker: Checker,
  expr: Pattern,
  at: Segments
): CheckedNode | undefined => {
  const left = typePath(checker, expr.left, [...at, "left"]);

  if (
    left === undefined ||
    !checkOperator(checker, expr.op, left.field.type.kind, at)
  ) {
    return undefined;
  }

  const { kind } = left.field.type;
  const pattern = expr.op === "notContains" ? "contains" : expr.op;

  if (kind !== "text" && kind !== "longText") {
    return undefined;
  }

  const needle = convertNeedleLiteral(pattern, kind, expr.right);

  if (!needle.ok) {
    checker.issues.push(literalIssue(needle.error, [...at, "right"]));

    return undefined;
  }

  return negateIf(expr.op === "notContains", {
    left,
    needle: needle.value,
    op: "pattern",
    pattern,
  });
};

const typeSingle = (
  checker: Checker,
  expr: Empty | Changed,
  at: Segments
): CheckedNode | undefined => {
  const arg = typePath(checker, expr.arg, [...at, "arg"]);

  if (
    arg === undefined ||
    !checkOperator(checker, expr.op, arg.field.type.kind, at)
  ) {
    return undefined;
  }

  if (expr.op === "changed") {
    if (arg.image === "previous") {
      checker.issues.push(
        issue(
          "previousNotAllowed",
          [...at, "arg", "image"],
          "changed compares the previous and proposed images itself."
        )
      );

      return undefined;
    }

    return { arg, op: "changed" };
  }

  return negateIf(expr.op === "notEmpty", { arg, op: "empty" });
};

const typePeriod = (
  checker: Checker,
  expr: InPeriod,
  at: Segments
): CheckedNode | undefined => {
  const left = typePath(checker, expr.left, [...at, "left"]);

  if (
    left === undefined ||
    !checkOperator(checker, expr.op, left.field.type.kind, at)
  ) {
    return undefined;
  }

  const fits =
    requireContext(checker, "now", [...at, "period"]) &&
    checkOffset(checker, expr.period.offset, [...at, "period"]);

  return fits
    ? {
        left,
        offset: expr.period.offset,
        op: "inPeriod",
        unit: expr.period.unit,
      }
    : undefined;
};

const typeAtom = (
  checker: Checker,
  expr: Expr,
  at: Segments
): CheckedNode | undefined => {
  if (isCompare(expr)) {
    return typeCompare(checker, expr, at);
  }

  if (isIn(expr)) {
    return typeIn(checker, expr, at);
  }

  if (isPatternTest(expr)) {
    return typePattern(checker, expr, at);
  }

  if (isEmptyTest(expr) || expr.op === "changed") {
    return typeSingle(checker, expr, at);
  }

  return expr.op === "inPeriod" ? typePeriod(checker, expr, at) : undefined;
};

const typeExpr = (
  checker: Checker,
  expr: Expr,
  at: Segments
): CheckedNode | undefined => {
  if (isJunction(expr)) {
    const args = expr.args.map((arg, index) =>
      typeExpr(checker, arg, [...at, "args", index])
    );

    return args.every((arg) => arg !== undefined)
      ? { args: args.filter((arg) => arg !== undefined), op: expr.op }
      : undefined;
  }

  if (expr.op === "not") {
    const arg = typeExpr(checker, expr.arg, [...at, "arg"]);

    return arg === undefined ? undefined : { arg, op: "not" };
  }

  if (expr.op === "true" || expr.op === "false") {
    return { op: "const", value: expr.op === "true" };
  }

  return typeAtom(checker, expr, at);
};

/**
 * Checks a condition against a class and a profile.
 *
 * @param expr - The condition.
 * @param options - The view, class, profile and purpose.
 * @returns The checked condition, or an `InvalidCondition` listing every
 *   issue with its path into the AST.
 */
export const checkCondition = (
  expr: Expr,
  options: CheckOptions
): ConditionResult<CheckedCondition> => {
  if (exprDepth(expr) > MAX_CONDITION_DEPTH) {
    return invalid([tooDeep]);
  }

  // Conditions built in code skip the JSON decoder; hold them to the same
  // schema (integral offsets, known units, UUID field IDs, ...).
  if (!isExpr(expr)) {
    return invalid([notAnAst]);
  }

  const checker: Checker = {
    issues: [],
    options,
    rules: profileRules(options.profile, options.profileOptions),
  };

  const root = typeExpr(checker, expr, []);

  if (root === undefined || checker.issues.length > 0) {
    return invalid(
      checker.issues.length > 0
        ? checker.issues
        : [issue("malformed", [], "The condition does not check.")]
    );
  }

  return valid(makeChecked(options.classId, root));
};

/**
 * Decodes the JSON form of a condition and checks it.
 *
 * @param json - Parsed JSON, as stored in a `condition` field.
 * @param options - The view, class, profile and purpose.
 * @returns The checked condition, or an `InvalidCondition`; a JSON value
 *   that is not a condition AST gives one `malformed` issue.
 */
export const checkConditionJson = (
  json: JsonValue,
  options: CheckOptions
): ConditionResult<CheckedCondition> => {
  const decoded = decodeExpr(json);

  if (decoded._tag === "Failure") {
    return invalid([decoded.failure === "tooDeep" ? tooDeep : notAnAst]);
  }

  return checkCondition(decoded.success, options);
};
