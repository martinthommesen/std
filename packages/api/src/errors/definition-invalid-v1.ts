/**
 * `DefinitionInvalid` as frozen `/api/v1` shows it (Contracts 10.1): the
 * problem codes of `v0.0.2`, so the v1 OpenAPI document never changes.
 * Codes added later (`apiNameClash`, Contracts 10.2; `invalidRecordRule`,
 * workstream 3A) reach a v1 client as
 * the nearest v0.0.2 code ({@link toV1DefinitionInvalid}); `/api/v2` shows
 * them as they are.
 */
import type { DefinitionInvalid } from "@std/definitions/problems";
import { Schema } from "effect";

/** The problem codes of `v0.0.2`, in their order. */
const ProblemCodeV1Schema = Schema.Literals([
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

/** One problem, as v1 shows it. */
const DefinitionProblemV1Schema = Schema.Struct({
  code: ProblemCodeV1Schema,
  /** The definition the problem is about, if any. */
  definitionId: Schema.NullOr(Schema.String),
  message: Schema.String,
});

/** Definitions or a change set are invalid; nothing was applied (v1). */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DefinitionInvalidV1 extends Schema.TaggedError<
  DefinitionInvalidV1,
  { readonly brand: unique symbol }
>()("DefinitionInvalid", {
  problems: Schema.Array(DefinitionProblemV1Schema),
}) {}

/** Codes `v0.0.2` did not have, and the nearest code it had. */
const NEAREST_V1_CODE = {
  // The aggregate graph (Contracts 4.9, decision 0029): a cycle is the
  // nearest of `extendsCycle`; a fourth level or a second owner reference
  // is a field type the configuration cannot take.
  aggregateCycle: "extendsCycle",
  aggregateSecondOwner: "invalidType",
  aggregateTooDeep: "invalidType",
  // The name is not valid for the API.
  apiNameClash: "invalidName",
  // A record rule (workstream 3A) is a rule definition over records, as an
  // access rule is; the message names the problem.
  invalidRecordRule: "invalidAccessRule",
} as const;

type LaterCode = keyof typeof NEAREST_V1_CODE;

const isLaterCode = (code: string): code is LaterCode =>
  Object.hasOwn(NEAREST_V1_CODE, code);

/**
 * The v1 form of a refusal: a code `v0.0.2` did not have becomes the
 * nearest code it had ({@link NEAREST_V1_CODE}).
 *
 * @param error - The refusal.
 * @returns The same problems with v0.0.2 codes.
 */
export const toV1DefinitionInvalid = (
  error: DefinitionInvalid
): DefinitionInvalidV1 =>
  new DefinitionInvalidV1({
    problems: error.problems.map((found) => ({
      code: isLaterCode(found.code) ? NEAREST_V1_CODE[found.code] : found.code,
      definitionId: found.definitionId,
      message: found.message,
    })),
  });
