/**
 * The printer of the condition text syntax: field IDs print as their current
 * names, so `parseCondition(printCondition(a))` gives `a` back for every
 * checked condition. Junctions with fewer than two arguments print as
 * `all(...)` and `any(...)`, nested junctions are parenthesized, and names
 * that are keywords or not plain words are quoted with backticks, so the
 * round trip keeps the AST exactly.
 */
import type { FieldKind } from "@std/values/field-type";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonString,
} from "@std/values/json-value";

import {
  isCompare,
  isEmptyTest,
  isIn,
  isJunction,
  isMyGroups,
  isPath,
  isPatternTest,
} from "./ast.ts";
import type {
  Compare,
  Expr,
  In,
  LiteralValue,
  NowUnit,
  Path,
  Pattern,
  Period,
  TodayUnit,
  Value,
} from "./ast.ts";
import type { FieldInfo } from "./class-view.ts";
import { invalid, issue, valid } from "./issue.ts";
import type { ConditionResult } from "./issue.ts";
import { KEYWORDS } from "./syntax-lexer.ts";

/** How the printer finds names. */
export interface PrintOptions {
  /** The class the condition applies to. */
  readonly classId: string;
  /** Finds a field by ID on a class; `ClassView.field` fits. */
  readonly field: (classId: string, fieldId: string) => FieldInfo | undefined;
}

/** Thrown inside the printer only; `printCondition` turns it into an issue. */
class PrintFailureError extends Error {
  override readonly name = "PrintFailureError";
}

const PLAIN_NAME = /^[A-Z_a-z]\w*$/u;
const DIGIT_TEXT = /^-?\d+(?:\.\d+)?$/u;

// C0, DEL, C1, U+2028, U+2029 and lone surrogates print as \u{...}.
const LAST_C0 = 0x1f;
const DELETE = 0x7f;
const LAST_C1 = 0x9f;
const LINE_SEPARATOR = 0x20_28;
const PARAGRAPH_SEPARATOR = 0x20_29;
const SURROGATE_FIRST = 0xd8_00;
const SURROGATE_LAST = 0xdf_ff;

const isControl = (codePoint: number): boolean =>
  codePoint <= LAST_C0 || (codePoint >= DELETE && codePoint <= LAST_C1);

const isLineBreak = (codePoint: number): boolean =>
  codePoint === LINE_SEPARATOR || codePoint === PARAGRAPH_SEPARATOR;

const isSurrogate = (codePoint: number): boolean =>
  codePoint >= SURROGATE_FIRST && codePoint <= SURROGATE_LAST;

const needsCodeEscape = (codePoint: number): boolean =>
  isControl(codePoint) || isLineBreak(codePoint) || isSurrogate(codePoint);

const HEX = 16;

const ESCAPES = new Map([
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\\", "\\\\"],
]);

const COMPARE_SYMBOLS = new Map([
  ["eq", "="],
  ["ge", ">="],
  ["gt", ">"],
  ["le", "<="],
  ["lt", "<"],
  ["ne", "!="],
]);

const PATTERN_WORDS = new Map([
  ["contains", "contains"],
  ["endsWith", "ends with"],
  ["notContains", "not contains"],
  ["startsWith", "starts with"],
]);

const RELATIVE_WORDS = new Map([
  [-1, "last"],
  [0, "this"],
  [1, "next"],
]);

const NUMBER_KINDS: ReadonlySet<FieldKind> = new Set([
  "integer",
  "bigInteger",
  "decimal",
]);

const quote = (text: string, delimiter: string): string => {
  let out = delimiter;

  // Iterating code points keeps pairs together and yields lone surrogates
  // on their own, which are escaped.
  for (const character of text) {
    const simple = ESCAPES.get(character);

    if (simple !== undefined) {
      out += simple;
    } else if (character === delimiter) {
      out += `\\${delimiter}`;
    } else if (needsCodeEscape(character.codePointAt(0) ?? 0)) {
      out += `\\u{${(character.codePointAt(0) ?? 0).toString(HEX)}}`;
    } else {
      out += character;
    }
  }

  return `${out}${delimiter}`;
};

const printName = (name: string): string =>
  PLAIN_NAME.test(name) && !KEYWORDS.has(name) ? name : quote(name, "`");

interface Printed {
  readonly text: string;
  readonly field: FieldInfo;
}

const nextClass = (field: FieldInfo): string => {
  if (field.type.kind !== "reference") {
    throw new PrintFailureError(
      "A path follows a field that is not a reference."
    );
  }

  return field.type.targetClassId;
};

const printPath = (options: PrintOptions, path: Path): Printed => {
  let { classId } = options;
  let field: FieldInfo | undefined;
  const names: string[] = [];

  for (const id of path.path) {
    classId = field === undefined ? classId : nextClass(field);
    field = options.field(classId, id);

    if (field === undefined) {
      throw new PrintFailureError(
        "A path names a field this class does not have."
      );
    }

    names.push(printName(field.name));
  }

  if (field === undefined) {
    throw new PrintFailureError("A path names no field.");
  }

  const prefix = path.image === "previous" ? "previous." : "";

  return { field, text: `${prefix}${names.join(".")}` };
};

const plural = (unit: string, offset: number): string =>
  Math.abs(offset) === 1 ? unit : `${unit}s`;

const printRelative = (
  word: "now" | "today",
  unit: NowUnit | TodayUnit,
  offset: number
): string => {
  const sign = offset < 0 ? "-" : "+";

  return `${word} ${sign} ${Math.abs(offset)} ${plural(unit, offset)}`;
};

const printNumber = (kind: FieldKind, value: LiteralValue["value"]): string => {
  if (
    kind === "integer" &&
    isJsonNumber(value) &&
    Number.isSafeInteger(value)
  ) {
    return String(value);
  }

  if (kind !== "integer" && isJsonString(value) && DIGIT_TEXT.test(value)) {
    return value;
  }

  throw new PrintFailureError("A number literal does not have its type.");
};

const printLiteral = (field: FieldInfo, literal: LiteralValue): string => {
  const { value } = literal;
  const { kind } = field.type;

  if (NUMBER_KINDS.has(kind)) {
    return printNumber(kind, value);
  }

  if (kind === "boolean" && isJsonBoolean(value)) {
    return value ? "true" : "false";
  }

  if (kind !== "boolean" && isJsonString(value)) {
    return quote(value, '"');
  }

  throw new PrintFailureError("A literal does not have its field's type.");
};

const printValue = (field: FieldInfo, value: Value): string => {
  if ("value" in value) {
    return printLiteral(field, value);
  }

  if ("ctx" in value) {
    return value.ctx;
  }

  if (value.rel === "today" && value.unit === "day" && value.offset === 0) {
    return "today";
  }

  return printRelative(value.rel, value.unit, value.offset);
};

const printPeriod = (period: Period): string => {
  const word = RELATIVE_WORDS.get(period.offset);

  if (word !== undefined) {
    return `${word} ${period.unit}`;
  }

  const sign = period.offset < 0 ? "-" : "+";

  return `${period.unit} ${sign}${Math.abs(period.offset)}`;
};

const printCompare = (options: PrintOptions, expr: Compare): string => {
  const left = printPath(options, expr.left);

  const right = isPath(expr.right)
    ? printPath(options, expr.right).text
    : printValue(left.field, expr.right);

  return `${left.text} ${COMPARE_SYMBOLS.get(expr.op) ?? "="} ${right}`;
};

const printIn = (options: PrintOptions, expr: In): string => {
  const left = printPath(options, expr.left);
  const operator = expr.op === "in" ? "in" : "not in";

  const right = isMyGroups(expr.right)
    ? "myGroups"
    : `(${expr.right.map((value) => printValue(left.field, value)).join(", ")})`;

  return `${left.text} ${operator} ${right}`;
};

const printPattern = (options: PrintOptions, expr: Pattern): string => {
  const left = printPath(options, expr.left).text;

  return `${left} ${PATTERN_WORDS.get(expr.op) ?? "contains"} ${quote(expr.right, '"')}`;
};

const printAtom = (options: PrintOptions, expr: Expr): string => {
  if (isCompare(expr)) {
    return printCompare(options, expr);
  }

  if (isIn(expr)) {
    return printIn(options, expr);
  }

  if (isEmptyTest(expr)) {
    const arg = printPath(options, expr.arg).text;

    return expr.op === "empty" ? `${arg} is empty` : `${arg} is not empty`;
  }

  if (isPatternTest(expr)) {
    return printPattern(options, expr);
  }

  if (expr.op === "inPeriod") {
    return `${printPath(options, expr.left).text} in ${printPeriod(expr.period)}`;
  }

  if (expr.op === "changed") {
    return `changed(${printPath(options, expr.arg).text})`;
  }

  throw new PrintFailureError("Not an atom.");
};

const isChain = (expr: Expr): boolean =>
  isJunction(expr) && expr.args.length >= 2;

const printExpr = (options: PrintOptions, expr: Expr): string => {
  if (isJunction(expr)) {
    if (expr.args.length < 2) {
      const name = expr.op === "and" ? "all" : "any";
      const args = expr.args.map((arg) => printExpr(options, arg));

      return `${name}(${args.join(", ")})`;
    }

    return expr.args
      .map((arg) => {
        const printed = printExpr(options, arg);

        return isChain(arg) ? `(${printed})` : printed;
      })
      .join(` ${expr.op} `);
  }

  if (expr.op === "not") {
    const printed = printExpr(options, expr.arg);

    return isChain(expr.arg) ? `not (${printed})` : `not ${printed}`;
  }

  if (expr.op === "true" || expr.op === "false") {
    return expr.op;
  }

  return printAtom(options, expr);
};

/**
 * Prints a condition with field names.
 *
 * @param expr - The condition.
 * @param options - The class and the field lookup.
 * @returns The text, or an `InvalidCondition` when a field ID does not
 *   resolve or a literal does not have its field's type (conditions that
 *   passed the checker always print).
 */
export const printCondition = (
  expr: Expr,
  options: PrintOptions
): ConditionResult<string> => {
  try {
    return valid(printExpr(options, expr));
  } catch (error) {
    if (error instanceof PrintFailureError) {
      return invalid([issue("malformed", [], error.message)]);
    }

    throw error;
  }
};
