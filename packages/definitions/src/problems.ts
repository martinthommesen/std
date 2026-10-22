/**
 * Typed validation results for definitions.
 *
 * Validation never throws: it returns a list of `DefinitionProblem` values,
 * and operations that cannot proceed fail with `DefinitionInvalid` carrying
 * them. Messages name definitions by ID and name, never by value, so they can
 * be returned to an admin as they are.
 */
import {
  Array as SchemaArray,
  Literals,
  NullOr,
  String as SchemaString,
  Struct,
  TaggedError,
} from "effect/Schema";

/** Every problem code. */
export const ProblemCodeSchema = Literals([
  "invalidName",
  "duplicateName",
  "duplicateId",
  "unknownReference",
  "wrongKind",
  "notLive",
  "extendsCycle",
  "invalidType",
  "invalidDefault",
  "defaultNotAllowed",
  "invalidDisplayField",
  "overrideNotInherited",
  "overrideLoosens",
  "overrideInvalid",
  "invalidIndex",
  "invalidGrant",
  "invalidAccessRule",
  "invalidCondition",
  "invalidSubscription",
  "invalidChoice",
  "invalidLayout",
  "invalidAutoNumber",
  "invalidFlags",
  "unknownDefinition",
  "alreadyExists",
  "idInUse",
  "versionConflict",
  "unsupportedChange",
]);

/** A problem code. */
export type ProblemCode = typeof ProblemCodeSchema.Type;

/** One problem found in a set of definitions or a change set. */
export const DefinitionProblemSchema = Struct({
  code: ProblemCodeSchema,
  /** The definition the problem is about, if any. */
  definitionId: NullOr(SchemaString),
  message: SchemaString,
});

/** One problem. */
export type DefinitionProblem = typeof DefinitionProblemSchema.Type;

/**
 * Builds a problem.
 *
 * @param code - The problem code.
 * @param definitionId - The definition it is about, or null.
 * @param message - A message naming definitions by ID or name only.
 * @returns The problem.
 */
export const problem = (
  code: ProblemCode,
  definitionId: string | null,
  message: string
): DefinitionProblem => ({ code, definitionId, message });

/** Definitions or a change set are invalid; nothing was applied. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class DefinitionInvalid extends TaggedError<
  DefinitionInvalid,
  { readonly brand: unique symbol }
>()("DefinitionInvalid", { problems: SchemaArray(DefinitionProblemSchema) }) {
  /**
   * The first few problems, one per line.
   *
   * @returns The message.
   */
  override get message(): string {
    const shown = this.problems
      .slice(0, 10)
      .map((entry) => `${entry.code}: ${entry.message}`);

    const more =
      this.problems.length > shown.length
        ? [`... and ${this.problems.length - shown.length} more`]
        : [];

    return ["Definitions are invalid:", ...shown, ...more].join("\n");
  }
}
