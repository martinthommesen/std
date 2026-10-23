/**
 * The actions of `after` and `afterCommit` rules (Contracts 4.10):
 * `updateEach` and `createEach`, each a nested save through the full
 * pipeline as the `Actor` in the environment.
 *
 * - `forEach` selects records of its class and its subclasses as system
 *   (every row, whatever the actor may see), in stable ID order, with its
 *   `where` compiled to SQL; `scope: "record"` paths read the rule's
 *   record (`rule-for-each.ts`). The saves then run as the actor, so
 *   access rules refuse them exactly as they would the actor's own write
 *   (`NotFound` for a record the actor cannot see, `NotAllowed`,
 *   `UnknownField`).
 * - `updateEach` saves each selected record (`target: "self"`, through
 *   the `forEach` class's endpoint) or the record its reference field
 *   names (`target: { via }`, through the referenced class's endpoint;
 *   an empty reference saves nothing, and each target is saved once), at
 *   the version just read. `createEach` creates one record of its class
 *   per selected record.
 * - Bodies name fields by their current name, so the save resolves them
 *   like a client's; the rule itself holds field IDs only.
 *
 * Nested saves join the transaction without a savepoint; a failing one
 * poisons it, so the outermost save rolls back even when a caller catches
 * the failure (4.1).
 */
import type { RecordRuleDefinition } from "@std/definitions/definition";
import type {
  RuleAction,
  RuleAssignment,
} from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Option } from "effect";

import type { ChangeCause } from "../records/change-entry.ts";
import { createRecord, updateRecord } from "../records/save-pipeline.ts";
import type { RuleContext } from "./rule-condition.ts";
import { rootOf, selectForEach, sourceImage } from "./rule-for-each.ts";
import type { ForEachInput, RuleRecord, Selected } from "./rule-for-each.ts";
import { assignedValue, bodyValue } from "./rule-values.ts";
import type { ValueRecord } from "./rule-values.ts";

/** What an action runs with. */
export interface ActionInput {
  readonly snapshot: ConfigSnapshot;
  readonly rule: RecordRuleDefinition;
  readonly record: RuleRecord;
  /** The cause every nested save records (`hook` or `after_commit`). */
  readonly cause: ChangeCause;
  /** `me` (the identity the actions run as) and `now`. */
  readonly context: RuleContext;
}

const forEachInput = (input: ActionInput): ForEachInput => ({
  context: input.context,
  record: input.record,
  ruleClassId: input.rule.classId,
  snapshot: input.snapshot,
});

/**
 * A nested save's body: each assigned field by its current name.
 *
 * @param input - The rule, its record and the context.
 * @param values - The action's assignments.
 * @param source - The selected record's image, for `copy` from `source`.
 * @returns The body.
 */
const bodyOf = (
  input: ActionInput,
  values: readonly RuleAssignment[],
  source: ValueRecord | null
): JsonObject => {
  const body: Record<string, JsonObject[string]> = {};

  for (const assignment of values) {
    const { field, value } = assignedValue(input.snapshot, assignment, {
      ...input.context,
      record: input.record,
      source,
    });

    body[field.name] = bodyValue(field.type, value);
  }

  return body;
};

const readsSource = (values: readonly RuleAssignment[]): boolean =>
  values.some(({ value }) => "copy" in value && value.copy.from === "source");

const updateEach = Effect.fn("Rules.updateEach")(function* updateEach(
  input: ActionInput,
  action: Extract<RuleAction, { readonly type: "updateEach" }>
) {
  const saved = new Set<string>();
  const needsSource = action.target !== "self" || readsSource(action.values);

  for (const selected of yield* selectForEach(
    forEachInput(input),
    action.forEach
  )) {
    const source = needsSource
      ? yield* sourceImage(input.snapshot, selected)
      : null;

    const { target } = action;

    let endpointClassId = action.forEach.classId;
    let targetRecord: Option.Option<Selected> = Option.some(selected);

    if (target !== "self") {
      const via = input.snapshot.field(target.via);
      const targetId = source?.image[target.via];

      endpointClassId =
        via?.type.kind === "reference"
          ? via.type.targetClassId
          : endpointClassId;

      targetRecord = isString(targetId)
        ? yield* rootOf(input.snapshot, endpointClassId, targetId)
        : Option.none();
    }

    if (Option.isSome(targetRecord) && !saved.has(targetRecord.value.id)) {
      saved.add(targetRecord.value.id);

      // A rule's update evaluates no patch, so no patch test can fail.
      yield* updateRecord({
        body: bodyOf(input, action.values, source),
        cause: input.cause,
        endpointClassId,
        expectedVersion: targetRecord.value.version,
        id: targetRecord.value.id,
      }).pipe(Effect.catchTag("PatchTestFailed", Effect.die));
    }
  }
});

const createEach = Effect.fn("Rules.createEach")(function* createEach(
  input: ActionInput,
  action: Extract<RuleAction, { readonly type: "createEach" }>
) {
  const needsSource = readsSource(action.values);

  for (const selected of yield* selectForEach(
    forEachInput(input),
    action.forEach
  )) {
    const source = needsSource
      ? yield* sourceImage(input.snapshot, selected)
      : null;

    yield* createRecord({
      body: bodyOf(input, action.values, source),
      cause: input.cause,
      endpointClassId: action.classId,
    });
  }
});

/**
 * Runs a rule's `updateEach` and `createEach` actions in order.
 *
 * @param input - The rule, its record, the cause and the context.
 * @returns Nothing; the first failing save fails it.
 */
export const runSaveActions = Effect.fn("Rules.runSaveActions")(
  function* runSaveActions(input: ActionInput) {
    for (const action of input.rule.actions) {
      if (action.type === "updateEach") {
        yield* updateEach(input, action);
      } else if (action.type === "createEach") {
        yield* createEach(input, action);
      } else {
        return yield* Effect.die(
          new RangeError(`A ${action.type} action does not save records.`)
        );
      }
    }

    return yield* Effect.void;
  }
);
