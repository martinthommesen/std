/**
 * Record-rule conditions (Contracts 4.10, 5.10): the record-rule profile,
 * evaluated in TypeScript on complete images, with `previous` for the
 * stored record (all-null on create, the record itself on delete),
 * context `me` and `now` in the instance time zone, and reference paths of
 * up to 3 hops whose targets are preloaded as system: every field of the
 * target is read, whatever the acting user may see.
 *
 * A stored condition that no longer checks against the snapshot is a
 * defect, as for subscriptions: definition validation refuses such a rule,
 * so the save fails rather than silently skipping the rule.
 */
import { pathsOfNode } from "@std/conditions/aggregate";
import { checkCondition } from "@std/conditions/check";
import { ConditionDefectError } from "@std/conditions/defect";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import type { CheckedCondition, TypedPath } from "@std/conditions/typed";
import type { Condition } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import { loadRecord } from "../records/save-sql.ts";
import { imageOf } from "../records/stored-record.ts";

/** What a rule condition is resolved with (5.10: `me`, `now`). */
export interface RuleContext {
  /** The acting user. */
  readonly me: DefinitionId;
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
  /** The instance time zone: rules never use the user's. */
  readonly timeZone: string;
}

/** The images a rule condition reads. */
export interface RuleImages {
  /** The record as it will be saved (the stored one for a delete). */
  readonly record: RecordImage;
  /** The stored record; null on create. */
  readonly previous: RecordImage | null;
  /**
   * Records whose in-memory image replaces the database when a path
   * follows a reference to them: the settling images of 4.9, so a
   * `derive` rule run while settling reads what settling proposed.
   */
  readonly live?: ReadonlyMap<string, RecordImage>;
  /** The current record takes precedence over its shared settling image. */
  readonly liveRecordId?: string | null;
}

const checkedConditions = new WeakMap<
  ConfigSnapshot,
  WeakMap<Condition, Map<string, CheckedCondition>>
>();

/**
 * Checks a stored rule condition against a class, as it runs.
 *
 * @param snapshot - The configuration.
 * @param classId - The class the condition is evaluated on.
 * @param condition - The stored condition.
 * @param recordClassId - The rule's class, for `scope: "record"` paths.
 * @returns The checked condition; a defect when it no longer checks.
 */
export const checkedRuleCondition = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  condition: Condition,
  recordClassId?: DefinitionId
): CheckedCondition => {
  let conditions = checkedConditions.get(snapshot);

  if (conditions === undefined) {
    conditions = new WeakMap();
    checkedConditions.set(snapshot, conditions);
  }

  let classes = conditions.get(condition);

  if (classes === undefined) {
    classes = new Map();
    conditions.set(condition, classes);
  }

  const key = `${classId}/${recordClassId ?? ""}`;
  const known = classes.get(key);

  if (known !== undefined) {
    return known;
  }

  const options = {
    classId,
    profile: "recordRule",
    purpose: "evaluate",
    view: classViewOf(snapshot),
  } as const;

  const checked = checkCondition(
    condition,
    recordClassId === undefined ? options : { ...options, recordClassId }
  );

  if (!checked.ok) {
    throw new ConditionDefectError(
      "A stored record-rule condition does not check against the configuration."
    );
  }

  classes.set(key, checked.value);

  return checked.value;
};

/**
 * Preload the reference targets a path crosses, preferring live images.
 * @param snapshot - The configuration.
 * @param path - The checked or resolved path.
 * @param start - The image the path starts from.
 * @param live - Lookup of images proposed in the current transaction.
 * @param targets - Shared cache of system-read target images, including missing records.
 * @returns Nothing; targets are populated for evaluation.
 */
export const preloadPath = Effect.fn("Rules.preloadPath")(function* preloadPath(
  snapshot: ConfigSnapshot,
  path: TypedPath,
  start: RecordImage | null,
  live: (id: string) => RecordImage | undefined,
  targets: Map<string, RecordImage | null>
) {
  let image = start;

  for (const [index, field] of path.fields.slice(0, -1).entries()) {
    const id = image?.[field.id];

    if (image === null || !isString(id) || field.type.kind !== "reference") {
      return;
    }

    const known = live(id) ?? targets.get(id);

    if (known === undefined) {
      const loaded = yield* loadRecord(
        snapshot,
        path.classes[index + 1] ?? field.type.targetClassId,
        id
      );

      image = Option.isSome(loaded) ? imageOf(loaded.value) : null;
    } else {
      image = known;
    }

    targets.set(id, image);
  }
});

const preloadTargets = Effect.fn("Rules.preloadTargets")(
  function* preloadTargets(
    snapshot: ConfigSnapshot,
    checked: CheckedCondition,
    images: RuleImages
  ) {
    const targets = new Map<string, RecordImage | null>();

    const live = (id: string) =>
      id === images.liveRecordId ? images.record : images.live?.get(id);

    for (const path of pathsOfNode(checked.root)) {
      yield* preloadPath(
        snapshot,
        path,
        path.image === "previous" ? images.previous : images.record,
        live,
        targets
      );
    }

    return targets;
  }
);

/**
 * Whether a rule's condition holds on images.
 *
 * @param snapshot - The configuration.
 * @param rule - The rule's class and condition (null always holds).
 * @param images - The record and its previous image.
 * @param context - `me`, `now` and the instance time zone.
 * @returns True when the condition holds.
 */
export const ruleConditionHolds = Effect.fn("Rules.conditionHolds")(
  function* ruleConditionHolds(
    snapshot: ConfigSnapshot,
    rule: {
      readonly classId: DefinitionId;
      readonly condition: Condition | null;
    },
    images: RuleImages,
    context: RuleContext
  ) {
    if (rule.condition === null) {
      return true;
    }

    const checked = checkedRuleCondition(
      snapshot,
      rule.classId,
      rule.condition
    );

    const resolved = resolveCondition(checked, context);

    if (!resolved.ok) {
      return yield* Effect.die(
        new ConditionDefectError("A record-rule condition does not resolve.")
      );
    }

    const targets = yield* preloadTargets(snapshot, checked, images);

    return evaluateCondition(resolved.value, {
      previous: images.previous,
      record: images.record,
      targets,
    });
  }
);
