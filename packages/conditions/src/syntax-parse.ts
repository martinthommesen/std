import { comparisonClass } from "@std/values/field-type";
/**
 * The parser of the condition text syntax (grammar in
 * `docs/decisions/0005-conditions.md`). Names resolve to field IDs through
 * the caller's callback, so the server can resolve against a caller's
 * visible schema and the definitions at a request's revision; a name that
 * does not resolve gives `unknownField`. Literals become the left field
 * type's canonical JSON (numbers stay digit text for big integers and
 * decimals and never pass through a JS `number`).
 *
 * The parser never throws: every problem is an `InvalidCondition` with the
 * position of the offending text. It checks syntax and names only; run
 * `checkCondition` on the result, and `locateIssues` to give the checker's
 * issues positions in the text.
 */
import type { FieldKind } from "@std/values/field-type";
import { convertNumberText } from "@std/values/literal";

import {
  MAX_CONDITION_DEPTH,
  isCompare,
  isEmptyTest,
  isIn,
  isJunction,
  isMyGroups,
  isPatternTest,
} from "./ast.ts";
import type {
  CompareOperator,
  Expr,
  MyGroups,
  NowUnit,
  Path,
  Period,
  PeriodUnit,
  TodayUnit,
  Value,
} from "./ast.ts";
import type { FieldInfo } from "./class-view.ts";
import { invalid, issue, valid } from "./issue.ts";
import type {
  AstPathSegment,
  ConditionIssue,
  ConditionResult,
  IssueReason,
  Span,
} from "./issue.ts";
import { KEYWORDS, tokenize } from "./syntax-lexer.ts";
import type { Token } from "./syntax-lexer.ts";

/** How the parser resolves names. */
export interface ParseOptions {
  /** The class the condition applies to. */
  readonly classId: string;
  /**
   * Resolves a field name on a class (the condition's class, then each
   * reference's target class). `ClassView.fieldByName` fits.
   */
  readonly resolveName: (
    classId: string,
    name: string
  ) => FieldInfo | undefined;
}

/** A parsed condition and where each AST node came from. */
export interface ParsedCondition {
  readonly expr: Expr;
  /** Spans keyed by AST path joined with `/` (`""` for the root). */
  readonly spans: ReadonlyMap<string, Span>;
}

/** Thrown inside the parser only; `parseCondition` turns it into an issue. */
class ParseFailureError extends Error {
  override readonly name = "ParseFailureError";
  readonly reason: IssueReason;
  readonly span: Span;

  constructor(reason: IssueReason, span: Span, message: string) {
    super(message);
    this.reason = reason;
    this.span = span;
  }
}

interface Parser {
  readonly tokens: readonly Token[];
  readonly options: ParseOptions;
  /** Spans by AST node: expressions, paths, values, lists and periods. */
  readonly spans: Map<object, Span>;
  index: number;
  /** How many `not`s and parentheses enclose the current position. */
  depth: number;
}

/**
 * The deepest nesting of `not`, parentheses, `all(...)` and `any(...)` the
 * parser follows. Printing a condition of the checker's depth limit nests at
 * most twice as deep (a parenthesized junction costs two levels), so this
 * keeps `parse(print(a)) = a` while bounding the parser's recursion.
 */
export const MAX_PARSE_NESTING = 2 * MAX_CONDITION_DEPTH + 2;

const NOW_UNITS = new Map<string, NowUnit>([
  ["day", "day"],
  ["days", "day"],
  ["hour", "hour"],
  ["hours", "hour"],
  ["minute", "minute"],
  ["minutes", "minute"],
  ["month", "month"],
  ["months", "month"],
  ["week", "week"],
  ["weeks", "week"],
  ["year", "year"],
  ["years", "year"],
]);

const TODAY_UNITS = new Map<string, TodayUnit>([
  ["day", "day"],
  ["days", "day"],
  ["month", "month"],
  ["months", "month"],
  ["week", "week"],
  ["weeks", "week"],
  ["year", "year"],
  ["years", "year"],
]);

const PERIOD_UNITS = new Map<string, PeriodUnit>([
  ["day", "day"],
  ["month", "month"],
  ["quarter", "quarter"],
  ["week", "week"],
  ["year", "year"],
]);

const RELATIVE_PERIODS = new Map<string, number>([
  ["last", -1],
  ["next", 1],
  ["this", 0],
]);

const COMPARE_OPERATORS = new Map<string, CompareOperator>([
  ["!=", "ne"],
  ["<", "lt"],
  ["<=", "le"],
  ["=", "eq"],
  [">", "gt"],
  [">=", "ge"],
]);

const STRING_KINDS: ReadonlySet<FieldKind> = new Set([
  "text",
  "longText",
  "date",
  "dateTime",
  "choice",
  "reference",
  "uuid",
  "password",
  "secret",
  "json",
  "condition",
]);

const NO_SPAN: Span = { end: 0, start: 0 };

const peek = (parser: Parser, ahead = 0): Token =>
  parser.tokens[Math.min(parser.index + ahead, parser.tokens.length - 1)] ?? {
    kind: "end",
    span: NO_SPAN,
    text: "",
  };

const advance = (parser: Parser): Token => {
  const token = peek(parser);

  if (token.kind === "error") {
    throw new ParseFailureError("syntax", token.span, token.text);
  }

  if (token.kind !== "end") {
    parser.index += 1;
  }

  return token;
};

const isWord = (token: Token, word: string): boolean =>
  token.kind === "word" && token.text === word;

const isPunctuation = (token: Token, text: string): boolean =>
  token.kind === "punctuation" && token.text === text;

const failure = (token: Token, expected: string): ParseFailureError => {
  if (token.kind === "error") {
    return new ParseFailureError("syntax", token.span, token.text);
  }

  const found = token.kind === "end" ? "the end of the condition" : "this";

  return new ParseFailureError(
    "syntax",
    token.span,
    `Expected ${expected}, not ${found}.`
  );
};

const expectPunctuation = (parser: Parser, text: string): Token => {
  const token = peek(parser);

  if (!isPunctuation(token, text)) {
    throw failure(token, `"${text}"`);
  }

  return advance(parser);
};

const expectWord = (parser: Parser, word: string): Token => {
  const token = peek(parser);

  if (!isWord(token, word)) {
    throw failure(token, `"${word}"`);
  }

  return advance(parser);
};

// Records the span from `start` to the end of the last consumed token.
const mark = <A extends object>(parser: Parser, node: A, start: number): A => {
  const last = parser.tokens[parser.index - 1];
  parser.spans.set(node, { end: last?.span.end ?? start, start });

  return node;
};

const isNameToken = (token: Token): boolean =>
  token.kind === "quotedName" ||
  (token.kind === "word" && !KEYWORDS.has(token.text));

const startsPath = (parser: Parser): boolean => {
  const token = peek(parser);

  return (
    isNameToken(token) ||
    (isWord(token, "previous") && isPunctuation(peek(parser, 1), "."))
  );
};

interface ParsedPath {
  readonly path: Path;
  readonly field: FieldInfo;
}

const resolveName = (
  parser: Parser,
  classId: string,
  token: Token
): FieldInfo => {
  const field = parser.options.resolveName(classId, token.text);

  if (field === undefined) {
    throw new ParseFailureError(
      "unknownField",
      token.span,
      "No such field on this class."
    );
  }

  return field;
};

const nextClass = (field: FieldInfo, token: Token): string => {
  if (field.type.kind !== "reference") {
    throw new ParseFailureError(
      "notAReference",
      token.span,
      "Only reference fields can be followed."
    );
  }

  return field.type.targetClassId;
};

const parsePath = (parser: Parser): ParsedPath => {
  const { start } = peek(parser).span;
  const previous = isWord(peek(parser), "previous");

  if (previous) {
    advance(parser);
    expectPunctuation(parser, ".");
  }

  const ids: string[] = [];
  let { classId } = parser.options;
  let field: FieldInfo | undefined;

  for (;;) {
    const token = peek(parser);

    if (!isNameToken(token)) {
      throw failure(token, "a field name");
    }

    advance(parser);
    classId = field === undefined ? classId : nextClass(field, token);
    field = resolveName(parser, classId, token);
    ids.push(field.id);

    if (!isPunctuation(peek(parser), ".")) {
      break;
    }

    advance(parser);
  }

  const path: Path = previous
    ? { image: "previous", path: ids }
    : { path: ids };

  return { field, path: mark(parser, path, start) };
};

const parseOffsetNumber = (parser: Parser): number => {
  const token = peek(parser);

  if (token.kind !== "number" || token.text.includes(".")) {
    throw failure(token, "a whole number");
  }

  advance(parser);
  const value = Number(token.text);

  if (!Number.isSafeInteger(value)) {
    throw new ParseFailureError(
      "offsetOutOfRange",
      token.span,
      "The offset is too large."
    );
  }

  return value;
};

// An optional sign and a whole number; `-0` reads as 0.
const parseSigned = (
  parser: Parser,
  signRequired: boolean
): number | undefined => {
  const sign = peek(parser);
  const negative = isPunctuation(sign, "-");

  if (negative || isPunctuation(sign, "+")) {
    advance(parser);
  } else if (signRequired) {
    return undefined;
  }

  const magnitude = parseOffsetNumber(parser);

  return negative && magnitude !== 0 ? -magnitude : magnitude;
};

const parseUnit = <U extends string>(
  parser: Parser,
  units: ReadonlyMap<string, U>,
  expected: string
): U => {
  const token = peek(parser);
  const unit = token.kind === "word" ? units.get(token.text) : undefined;

  if (unit === undefined) {
    throw failure(token, expected);
  }

  advance(parser);

  return unit;
};

const parseRelative = (parser: Parser, word: "now" | "today"): Value => {
  const offset = parseSigned(parser, true);

  if (word === "now") {
    if (offset === undefined) {
      return { ctx: "now" };
    }

    const unit = parseUnit(
      parser,
      NOW_UNITS,
      "minutes, hours, days, weeks, months or years"
    );

    return { offset, rel: "now", unit };
  }

  if (offset === undefined) {
    return { offset: 0, rel: "today", unit: "day" };
  }

  const unit = parseUnit(parser, TODAY_UNITS, "days, weeks, months or years");

  return { offset, rel: "today", unit };
};

const literalError = (token: Token, message: string): ParseFailureError =>
  new ParseFailureError("invalidLiteral", token.span, message);

const parseNumberLiteral = (
  parser: Parser,
  field: FieldInfo,
  sign: string
): Value => {
  const token = peek(parser);

  if (token.kind !== "number") {
    throw failure(token, "a number");
  }

  advance(parser);
  const { kind } = field.type;

  if (comparisonClass(kind) !== "numeric") {
    throw literalError(token, "This field does not take a number.");
  }

  const digits = `${sign}${token.text}`;
  const converted = convertNumberText(kind, digits);

  if (!converted.ok) {
    throw literalError(token, converted.error.message);
  }

  return kind === "integer"
    ? { value: Number(converted.value) }
    : { value: digits };
};

const parseWordValue = (
  parser: Parser,
  field: FieldInfo,
  token: Token
): Value => {
  switch (token.text) {
    case "true":
    case "false": {
      advance(parser);

      if (field.type.kind !== "boolean") {
        throw literalError(token, "Only boolean fields take true or false.");
      }

      return { value: token.text === "true" };
    }

    case "me": {
      advance(parser);

      return { ctx: "me" };
    }

    case "now":
    case "today": {
      advance(parser);

      return parseRelative(parser, token.text);
    }

    case "myGroups": {
      throw new ParseFailureError(
        "myGroupsOnlyInIn",
        token.span,
        "myGroups may appear only as: field in myGroups."
      );
    }

    default: {
      throw failure(token, "a value");
    }
  }
};

const parseValue = (parser: Parser, field: FieldInfo): Value => {
  const token = peek(parser);
  let value: Value;

  if (token.kind === "string") {
    advance(parser);

    if (!STRING_KINDS.has(field.type.kind)) {
      throw literalError(token, "This field does not take a string.");
    }

    value = { value: token.text };
  } else if (isPunctuation(token, "-")) {
    advance(parser);
    value = parseNumberLiteral(parser, field, "-");
  } else if (token.kind === "number") {
    value = parseNumberLiteral(parser, field, "");
  } else if (token.kind === "word") {
    value = parseWordValue(parser, field, token);
  } else {
    throw failure(token, "a value");
  }

  return mark(parser, value, token.span.start);
};

// A comma-separated list in parentheses; `()` is empty.
const parseItems = <A>(parser: Parser, item: () => A): A[] => {
  expectPunctuation(parser, "(");
  const items: A[] = [];

  if (!isPunctuation(peek(parser), ")")) {
    items.push(item());

    while (isPunctuation(peek(parser), ",")) {
      advance(parser);
      items.push(item());
    }
  }

  expectPunctuation(parser, ")");

  return items;
};

const parsePeriod = (parser: Parser): Period => {
  const token = peek(parser);

  const relative =
    token.kind === "word" ? RELATIVE_PERIODS.get(token.text) : undefined;

  if (relative !== undefined) {
    advance(parser);

    const unit = parseUnit(
      parser,
      PERIOD_UNITS,
      "day, week, month, quarter or year"
    );

    return mark(parser, { offset: relative, unit }, token.span.start);
  }

  const unit = parseUnit(parser, PERIOD_UNITS, "a list, myGroups or a period");
  const offset = parseSigned(parser, false) ?? 0;

  return mark(parser, { offset, unit }, token.span.start);
};

const parseMembership = (
  parser: Parser,
  left: ParsedPath,
  negated: boolean
): Expr => {
  const op = negated ? "notIn" : "in";
  const token = peek(parser);

  if (isWord(token, "myGroups")) {
    advance(parser);
    const right = mark(parser, { ctx: "myGroups" as const }, token.span.start);

    return { left: left.path, op, right };
  }

  if (isPunctuation(token, "(")) {
    const right = parseItems(parser, () => parseValue(parser, left.field));

    return {
      left: left.path,
      op,
      right: mark(parser, right, token.span.start),
    };
  }

  if (negated) {
    throw failure(token, "a list or myGroups");
  }

  return { left: left.path, op: "inPeriod", period: parsePeriod(parser) };
};

const parseNeedle = (parser: Parser): string => {
  const token = peek(parser);

  if (token.kind !== "string") {
    throw failure(token, "a string");
  }

  advance(parser);

  return token.text;
};

const parseNegatedPredicate = (parser: Parser, left: ParsedPath): Expr => {
  const token = peek(parser);

  if (isWord(token, "in")) {
    advance(parser);

    return parseMembership(parser, left, true);
  }

  if (isWord(token, "contains")) {
    advance(parser);

    return { left: left.path, op: "notContains", right: parseNeedle(parser) };
  }

  throw failure(token, '"in" or "contains"');
};

const parseWordPredicate = (
  parser: Parser,
  left: ParsedPath,
  token: Token
): Expr => {
  switch (token.text) {
    case "in": {
      return parseMembership(parser, left, false);
    }

    case "not": {
      return parseNegatedPredicate(parser, left);
    }

    case "is": {
      const negated = isWord(peek(parser), "not");

      if (negated) {
        advance(parser);
      }

      expectWord(parser, "empty");

      return { arg: left.path, op: negated ? "notEmpty" : "empty" };
    }

    case "contains": {
      return { left: left.path, op: "contains", right: parseNeedle(parser) };
    }

    case "starts":
    case "ends": {
      expectWord(parser, "with");

      return {
        left: left.path,
        op: token.text === "starts" ? "startsWith" : "endsWith",
        right: parseNeedle(parser),
      };
    }

    default: {
      throw failure(token, "an operator");
    }
  }
};

const parsePredicate = (parser: Parser): Expr => {
  const left = parsePath(parser);
  const token = peek(parser);

  const op =
    token.kind === "punctuation"
      ? COMPARE_OPERATORS.get(token.text)
      : undefined;

  if (op !== undefined) {
    advance(parser);

    const right = startsPath(parser)
      ? parsePath(parser).path
      : parseValue(parser, left.field);

    return { left: left.path, op, right };
  }

  if (token.kind !== "word") {
    throw failure(token, "an operator");
  }

  advance(parser);

  return parseWordPredicate(parser, left, token);
};

// The grammar is mutually recursive; a holder object keeps it free of
// use-before-define.
interface Grammar {
  readonly disjunction: (parser: Parser) => Expr;
}

const parsePrimary = (grammar: Grammar, parser: Parser): Expr => {
  const token = peek(parser);

  if (isPunctuation(token, "(")) {
    advance(parser);
    const inner = grammar.disjunction(parser);
    expectPunctuation(parser, ")");

    return inner;
  }

  if (isWord(token, "true") || isWord(token, "false")) {
    advance(parser);

    return { op: token.text === "true" ? "true" : "false" };
  }

  if (isWord(token, "all") || isWord(token, "any")) {
    advance(parser);

    return {
      args: parseItems(parser, () => grammar.disjunction(parser)),
      op: token.text === "all" ? "and" : "or",
    };
  }

  if (isWord(token, "changed")) {
    advance(parser);
    expectPunctuation(parser, "(");
    const arg = parsePath(parser);
    expectPunctuation(parser, ")");

    return { arg: arg.path, op: "changed" };
  }

  if (!startsPath(parser)) {
    throw failure(token, "a condition");
  }

  return parsePredicate(parser);
};

const parseNegation = (grammar: Grammar, parser: Parser): Expr => {
  const token = peek(parser);

  if (parser.depth >= MAX_PARSE_NESTING) {
    throw new ParseFailureError(
      "tooDeep",
      token.span,
      `Conditions nest at most ${MAX_PARSE_NESTING} levels of not and parentheses.`
    );
  }

  parser.depth += 1;

  try {
    if (isWord(token, "not")) {
      advance(parser);
      const arg = parseNegation(grammar, parser);

      return mark(parser, { arg, op: "not" }, token.span.start);
    }

    return mark(parser, parsePrimary(grammar, parser), token.span.start);
  } finally {
    parser.depth -= 1;
  }
};

const parseChain = (
  parser: Parser,
  word: "and" | "or",
  operand: (parser: Parser) => Expr
): Expr => {
  const { start } = peek(parser).span;
  const first = operand(parser);

  if (!isWord(peek(parser), word)) {
    return first;
  }

  const args: Expr[] = [first];

  while (isWord(peek(parser), word)) {
    advance(parser);
    args.push(operand(parser));
  }

  return mark(parser, { args, op: word }, start);
};

const grammar: Grammar = {
  disjunction: (parser) =>
    parseChain(parser, "or", (inner) =>
      parseChain(inner, "and", (leaf) => parseNegation(grammar, leaf))
    ),
};

const key = (path: readonly AstPathSegment[]): string => path.join("/");

interface SpanWalk {
  readonly spans: ReadonlyMap<object, Span>;
  readonly out: Map<string, Span>;
}

/** A node the parser records a span for. */
type SpannedNode = Expr | Path | Value | Period | readonly Value[] | MyGroups;

const note = (
  walk: SpanWalk,
  node: SpannedNode,
  path: readonly AstPathSegment[]
): void => {
  const span = walk.spans.get(node);

  if (span !== undefined && !walk.out.has(key(path))) {
    walk.out.set(key(path), span);
  }
};

const noteAtom = (
  walk: SpanWalk,
  expr: Expr,
  at: readonly AstPathSegment[]
): void => {
  if (isCompare(expr)) {
    note(walk, expr.left, [...at, "left"]);
    note(walk, expr.right, [...at, "right"]);
  } else if (isIn(expr)) {
    note(walk, expr.left, [...at, "left"]);
    note(walk, expr.right, [...at, "right"]);

    if (!isMyGroups(expr.right)) {
      for (const [index, value] of expr.right.entries()) {
        note(walk, value, [...at, "right", index]);
      }
    }
  } else if (isPatternTest(expr)) {
    note(walk, expr.left, [...at, "left"]);
  } else if (expr.op === "inPeriod") {
    note(walk, expr.left, [...at, "left"]);
    note(walk, expr.period, [...at, "period"]);
  } else if (isEmptyTest(expr) || expr.op === "changed") {
    note(walk, expr.arg, [...at, "arg"]);
  }
};

// Keys each recorded node's span by its AST path.
const collectSpans = (
  walk: SpanWalk,
  expr: Expr,
  at: readonly AstPathSegment[]
): void => {
  note(walk, expr, at);

  if (isJunction(expr)) {
    for (const [index, arg] of expr.args.entries()) {
      collectSpans(walk, arg, [...at, "args", index]);
    }
  } else if (expr.op === "not") {
    collectSpans(walk, expr.arg, [...at, "arg"]);
  } else {
    noteAtom(walk, expr, at);
  }
};

/**
 * Parses condition text.
 *
 * @param text - The condition, such as `cost > 0 and status = "lost"`.
 * @param options - The class and the name resolver.
 * @returns The AST with source spans, or an `InvalidCondition` whose one
 *   issue carries the position (`span`) of the problem.
 */
export const parseCondition = (
  text: string,
  options: ParseOptions
): ConditionResult<ParsedCondition> => {
  const parser: Parser = {
    depth: 0,
    index: 0,
    options,
    spans: new Map(),
    tokens: tokenize(text),
  };

  try {
    const expr = grammar.disjunction(parser);
    const rest = peek(parser);

    if (rest.kind !== "end") {
      throw failure(rest, '"and", "or" or the end of the condition');
    }

    const spans = new Map<string, Span>();
    collectSpans({ out: spans, spans: parser.spans }, expr, []);

    return valid({ expr, spans });
  } catch (error) {
    if (error instanceof ParseFailureError) {
      return invalid([
        { ...issue(error.reason, [], error.message), span: error.span },
      ]);
    }

    throw error;
  }
};

/**
 * Adds text positions to issues from the checker: each issue gets the span
 * of the deepest AST node on its path that the parser recorded.
 *
 * @param issues - Issues with AST paths.
 * @param spans - The spans from `parseCondition`.
 * @returns The issues with `span` set where known.
 */
export const locateIssues = (
  issues: readonly ConditionIssue[],
  spans: ReadonlyMap<string, Span>
): ConditionIssue[] =>
  issues.map((found) => {
    for (let { length } = found.path; length >= 0; length -= 1) {
      const span = spans.get(key(found.path.slice(0, length)));

      if (span !== undefined) {
        return { ...found, span };
      }
    }

    return found;
  });
