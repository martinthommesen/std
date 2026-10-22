/**
 * The parts of a record rule (Contracts 4.10): its phase, its `before`
 * kind, its operations, and its actions with their values.
 *
 * - **Values** are a literal `{ value }` in the canonical JSON of the field
 *   they set (6.5); a context value `{ ctx: "now" | "me" }`; a copy
 *   `{ copy: { from, fieldId } }` of a field of the rule's record
 *   (`record`), the owner (`owner`, aggregate rules only) or the current
 *   `forEach` record (`source`), or with `fieldId` null that record's ID
 *   (`record.id`, `source.id`; nested saves only, decision 0022); or
 *   `{ increment: fieldId }`, the integer
 *   field's value on the rule's record plus 1 (1 when it is empty). Each
 *   action's values are a list of `{ fieldId, value }` so the stored JSON
 *   has one canonical order.
 * - **Actions** carry their kind in `type`: `set`, `refuse`, `setParts`,
 *   `createParts`, `updateEach` and `createEach`. A `forEach` names a class
 *   and an optional `where` on it; `where` may read the rule's own record
 *   through `scope: "record"` paths (`@std/conditions`).
 *
 * Which phase, kind and action go together is checked by
 * `rule-validation.ts`.
 */
import {
  Array as SchemaArray,
  Boolean as SchemaBoolean,
  Json,
  Literal,
  Literals,
  NullOr,
  optionalKey,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import { DefinitionIdSchema } from "./ids.ts";

/** When a rule runs (4.1, 4.10). */
export const RulePhaseSchema = Literals([
  "before",
  "after",
  "afterCommit",
  "aggregate",
]);

/** A rule phase. */
export type RulePhase = typeof RulePhaseSchema.Type;

/** The kind of a `before` rule. */
export const RuleKindSchema = Literals(["derive", "guard", "invariant"]);

/** A `before` rule's kind. */
export type RuleKind = typeof RuleKindSchema.Type;

/** The saves a rule applies to. */
export const RuleOperationSchema = Literals(["create", "update", "delete"]);

/** A rule operation. */
export type RuleOperation = typeof RuleOperationSchema.Type;

/** Where a copied value comes from. */
export const CopySourceSchema = Literals(["record", "owner", "source"]);

/** A copy source. */
export type CopySource = typeof CopySourceSchema.Type;

/** The value an action gives a field. */
export const RuleValueSchema = Union([
  Struct({ value: Json }),
  Struct({ ctx: Literals(["now", "me"]) }),
  Struct({
    copy: Struct({
      fieldId: NullOr(DefinitionIdSchema),
      from: CopySourceSchema,
    }),
  }),
  Struct({ increment: DefinitionIdSchema }),
]);

/** A rule value. */
export type RuleValue = typeof RuleValueSchema.Type;

/** One field an action sets. */
export const RuleAssignmentSchema = Struct({
  fieldId: DefinitionIdSchema,
  value: RuleValueSchema,
});

/** A field an action sets. */
export type RuleAssignment = typeof RuleAssignmentSchema.Type;

const Assignments = SchemaArray(RuleAssignmentSchema);

/** The records an action iterates: a class and an optional condition. */
export const RuleForEachSchema = Struct({
  classId: DefinitionIdSchema,
  where: NullOr(ConditionSchema),
});

/** A `forEach`. */
export type RuleForEach = typeof RuleForEachSchema.Type;

/** The error a `refuse` action fails with (422). */
export const RefusalCodeSchema = Literals(["InvalidTransition", "RuleRefused"]);

/** A refusal code. */
export type RefusalCode = typeof RefusalCodeSchema.Type;

/** What `updateEach` saves: the `forEach` record, or the one it references. */
export const RuleTargetSchema = Union([
  Literal("self"),
  Struct({ via: DefinitionIdSchema }),
]);

/** An `updateEach` target. */
export type RuleTarget = typeof RuleTargetSchema.Type;

/** Every action kind. */
export const RuleActionSchema = Union([
  Struct({
    /**
     * `before` rules only: leave alone every field the caller's body
     * names, whatever its value, so an explicit value wins (4.10). Absent:
     * false, the rule's value wins.
     */
    keepSupplied: optionalKey(SchemaBoolean),
    type: Literal("set"),
    values: Assignments,
  }),
  Struct({
    code: RefusalCodeSchema,
    message: SchemaString,
    type: Literal("refuse"),
  }),
  Struct({
    classId: DefinitionIdSchema,
    type: Literal("setParts"),
    values: Assignments,
    where: NullOr(ConditionSchema),
  }),
  Struct({
    classId: DefinitionIdSchema,
    forEach: NullOr(RuleForEachSchema),
    type: Literal("createParts"),
    values: Assignments,
  }),
  Struct({
    forEach: RuleForEachSchema,
    target: RuleTargetSchema,
    type: Literal("updateEach"),
    values: Assignments,
  }),
  Struct({
    classId: DefinitionIdSchema,
    forEach: RuleForEachSchema,
    type: Literal("createEach"),
    values: Assignments,
  }),
]);

/** An action. */
export type RuleAction = typeof RuleActionSchema.Type;

/** An action kind. */
export type RuleActionType = RuleAction["type"];

/** The action kinds each phase allows (4.10). */
export const PHASE_ACTIONS: Readonly<
  Record<RulePhase, readonly RuleActionType[]>
> = {
  after: ["updateEach", "createEach"],
  afterCommit: ["updateEach", "createEach"],
  aggregate: ["set", "refuse", "setParts", "createParts"],
  before: ["set", "refuse"],
};

/** The action kind each `before` kind allows (4.10). */
export const KIND_ACTIONS: Readonly<Record<RuleKind, RuleActionType>> = {
  derive: "set",
  guard: "refuse",
  invariant: "refuse",
};

/** The most records a `createParts` proposes per firing (4.10). */
export const CREATE_PARTS_MAX = 100;
