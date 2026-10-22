/**
 * Typed errors of the condition engine.
 *
 * - {@link InvalidCondition} lists every problem the checker, the resolver or
 *   the parser found, each with a path into the AST (`["args", 0, "right"]`)
 *   and, for the text syntax, a position in the source. Messages never
 *   contain literal values, so an issue can be logged or returned without
 *   leaking what the condition compared against.
 *
 * Programming errors throw `ConditionDefectError` (`@std/conditions/defect`).
 */
import {
  Array as SchemaArray,
  Int,
  Literals,
  optionalKey,
  String as SchemaString,
  Struct,
  TaggedError,
  Union,
} from "effect/Schema";

/** Every reason an issue can carry. */
export const IssueReasonSchema = Literals([
  "malformed",
  "unknownField",
  "retiredField",
  "notAReference",
  "tooManyHops",
  "pathNotPreloaded",
  "emptyPath",
  "previousNotAllowed",
  "operatorNotAllowed",
  "operatorNotForType",
  "contextNotAllowed",
  "contextNotForType",
  "myGroupsOnlyInIn",
  "comparisonClassMismatch",
  "invalidLiteral",
  "emptyLiteral",
  "emptyNeedle",
  "tooManyElements",
  "offsetOutOfRange",
  "invalidTimeZone",
  "invalidWeekStart",
  "temporalUnavailable",
  "syntax",
  "unknownName",
  "tooDeep",
  "scopeNotAllowed",
]);

/** A reason code. */
export type IssueReason = typeof IssueReasonSchema.Type;

/** A location in the text syntax: UTF-16 offsets, end exclusive. */
export const SpanSchema = Struct({ end: Int, start: Int });

/** A location in the text syntax. */
export type Span = typeof SpanSchema.Type;

/** A key or index into the AST's JSON form. */
export type AstPathSegment = string | number;

/** One problem with a condition. */
export const ConditionIssueSchema = Struct({
  hint: optionalKey(SchemaString),
  message: SchemaString,
  path: SchemaArray(Union([SchemaString, Int])),
  reason: IssueReasonSchema,
  span: optionalKey(SpanSchema),
});

/** One problem with a condition. */
export type ConditionIssue = typeof ConditionIssueSchema.Type;

/** A condition that does not check, resolve or parse. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class InvalidCondition extends TaggedError<
  InvalidCondition,
  { readonly brand: unique symbol }
>()("InvalidCondition", {
  issues: SchemaArray(ConditionIssueSchema),
}) {}

/** A successful step. */
export interface Valid<A> {
  readonly ok: true;
  readonly value: A;
}

/** A failed step. */
export interface Invalid {
  readonly ok: false;
  readonly error: InvalidCondition;
}

/** The result of checking, resolving or parsing. */
export type ConditionResult<A> = Valid<A> | Invalid;

/**
 * Wraps a successful result.
 *
 * @param value - The value.
 * @returns A success.
 */
export const valid = <A>(value: A): Valid<A> => ({ ok: true, value });

/**
 * Builds a failure from issues.
 *
 * @param issues - At least one issue.
 * @returns A failure carrying an `InvalidCondition`.
 */
export const invalid = (issues: readonly ConditionIssue[]): Invalid => ({
  error: new InvalidCondition({ issues: [...issues] }),
  ok: false,
});

/**
 * Builds one issue.
 *
 * @param reason - The reason code.
 * @param path - Where in the AST.
 * @param message - A message without literal values.
 * @param hint - What to write instead.
 * @returns The issue.
 */
export const issue = (
  reason: IssueReason,
  path: readonly AstPathSegment[],
  message: string,
  hint?: string
): ConditionIssue =>
  hint === undefined
    ? { message, path: [...path], reason }
    : { hint, message, path: [...path], reason };
