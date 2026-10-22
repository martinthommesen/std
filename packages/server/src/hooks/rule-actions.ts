import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
/**
 * The actions of `after` and `afterCommit` rules (Contracts 4.10):
 * `updateEach` and `createEach`, each a nested save through the full
 * pipeline as the `Actor` in the environment.
 *
 * - `forEach` selects records of its class and its subclasses as system
 *   (every row, whatever the actor may see), in stable ID order, with its
 *   `where` compiled to SQL; `scope: "record"` paths read the rule's
 *   record. The saves then run as the actor, so access rules refuse them
 *   exactly as they would the actor's own write (`NotFound` for a record
 *   the actor cannot see, `NotAllowed`, `UnknownField`).
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
import { compileCondition } from "@std/conditions/sql";
import {
  identSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { RecordRuleDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type {
  RuleAction,
  RuleAssignment,
  RuleForEach,
} from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Option } from "effect";

import type { ChangeCause } from "../records/change-entry.ts";
import { recordRelation } from "../records/relation.ts";
import { createRecord, updateRecord } from "../records/save-pipeline.ts";
import { loadRecord, rootTable } from "../records/save-sql.ts";
import { readRows } from "../records/sql-run.ts";
import { checkedRuleCondition, imageOf } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import { bodyValue, ruleValue } from "./rule-values.ts";
import type { ValueRecord } from "./rule-values.ts";

/** The record a rule runs for. */
export interface RuleRecord {
  readonly id: string;
  readonly image: RecordImage;
}

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

/** One record a `forEach` selected. */
interface Selected {
  readonly id: string;
  readonly classId: DefinitionId;
  readonly version: number;
}

const FOR_EACH_ALIAS = "r";

const selectedOf = (rows: readonly Record<string, string | null>[]) =>
  rows.flatMap((row): Selected[] =>
    isString(row.id) && isString(row.class_id) && isString(row.version)
      ? [{ classId: row.class_id, id: row.id, version: Number(row.version) }]
      : []
  );

/**
 * The records a `forEach` selects, as system, in ID order.
 *
 * @param input - The rule, its record and the context.
 * @param forEach - The class and condition.
 * @returns The records with their concrete class and version.
 */
const selectForEach = Effect.fn("Rules.selectForEach")(function* selectForEach(
  input: ActionInput,
  forEach: RuleForEach
) {
  const relation = recordRelation(input.snapshot, forEach.classId);
  let predicate = rawSql("TRUE");

  if (forEach.where !== null) {
    const checked = checkedRuleCondition(
      input.snapshot,
      forEach.classId,
      forEach.where,
      input.rule.classId
    );

    const resolved = resolveCondition(checked, {
      ...input.context,
      record: { id: input.record.id, values: input.record.image },
    });

    if (!resolved.ok) {
      return yield* Effect.die(
        new RangeError("A forEach condition does not resolve.")
      );
    }

    ({ predicate } = compileCondition(resolved.value, {
      alias: FOR_EACH_ALIAS,
      hooks: {
        column: (source, field) => identSql(source.alias, field.name),
        join: () => {
          throw new RangeError("A forEach condition follows no reference.");
        },
      },
      joinAliasPrefix: `${FOR_EACH_ALIAS}_hop`,
    }));
  }

  const rows = yield* readRows(
    sql`SELECT ${identSql(FOR_EACH_ALIAS, "id")}::text AS "id",
  ${identSql(FOR_EACH_ALIAS, "class_id")}::text AS "class_id",
  ${identSql(FOR_EACH_ALIAS, "version")}::text AS "version"
FROM ${relation} AS ${identSql(FOR_EACH_ALIAS)}
WHERE ${predicate}
ORDER BY ${identSql(FOR_EACH_ALIAS, "id")}`
  );

  return selectedOf(rows);
});

/**
 * The root row of a record: its concrete class and version.
 *
 * @param snapshot - The configuration.
 * @param classId - A class of its hierarchy.
 * @param id - The record ID.
 * @returns The record, or none.
 */
const rootOf = Effect.fn("Rules.rootOf")(function* rootOf(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  const rows = yield* readRows(
    sql`SELECT "id"::text AS "id", "class_id"::text AS "class_id", "version"::text AS "version"
FROM ${rawSql(rootTable(snapshot, classId))} WHERE "id" = ${textParameter(id, "uuid")}`
  );

  const [found] = selectedOf(rows);

  return Option.fromNullishOr(found);
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
    const field = input.snapshot.field(assignment.fieldId);

    if (field === undefined) {
      throw new RangeError(`Rule field ${assignment.fieldId} is unknown.`);
    }

    body[field.name] = bodyValue(
      field.type,
      ruleValue(assignment, field.type, {
        me: input.context.me,
        now: input.context.now,
        record: input.record,
        source,
      })
    );
  }

  return body;
};

const sourceImage = Effect.fn("Rules.sourceImage")(function* sourceImage(
  snapshot: ConfigSnapshot,
  selected: Selected
) {
  const loaded = yield* loadRecord(snapshot, selected.classId, selected.id);

  const found: ValueRecord | null = Option.isSome(loaded)
    ? { id: selected.id, image: imageOf(loaded.value) }
    : null;

  return found;
});

const updateEach = Effect.fn("Rules.updateEach")(function* updateEach(
  input: ActionInput,
  action: Extract<RuleAction, { readonly type: "updateEach" }>
) {
  const saved = new Set<string>();

  for (const selected of yield* selectForEach(input, action.forEach)) {
    const source = yield* sourceImage(input.snapshot, selected);
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
  for (const selected of yield* selectForEach(input, action.forEach)) {
    const source = yield* sourceImage(input.snapshot, selected);

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
