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
import { checkCondition } from "@std/conditions/check";
import { ConditionDefectError } from "@std/conditions/defect";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import type {
  CheckedCondition,
  CheckedNode,
  TypedPath,
} from "@std/conditions/typed";
import type { Condition } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import { loadRecord } from "../records/save-sql.ts";
import type { StoredRecord } from "../records/stored-record.ts";

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
}

/**
 * A record's values as an image.
 *
 * @param record - A stored record.
 * @returns Its values by field ID.
 */
export const imageOf = (record: StoredRecord): RecordImage =>
  Object.fromEntries(record.values);

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

  return checked.value;
};

const pathsOf = (node: CheckedNode): readonly TypedPath[] => {
  switch (node.op) {
    case "and":
    case "or": {
      return node.args.flatMap(pathsOf);
    }

    case "not": {
      return pathsOf(node.arg);
    }

    case "compare": {
      return node.right.kind === "path"
        ? [node.left, node.right.path]
        : [node.left];
    }

    case "in":
    case "pattern":
    case "inPeriod": {
      return [node.left];
    }

    case "empty":
    case "changed": {
      return [node.arg];
    }

    case "const": {
      return [];
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Loads the reference targets a condition's paths cross, as system: a
 * missing target reads as an empty reference.
 *
 * @param snapshot - The configuration.
 * @param checked - The checked condition.
 * @param images - The images the paths start from.
 * @returns Target images by record ID.
 */
const preloadTargets = Effect.fn("Rules.preloadTargets")(function* preload(
  snapshot: ConfigSnapshot,
  checked: CheckedCondition,
  images: RuleImages
) {
  const targets = new Map<string, RecordImage | null>();

  for (const path of pathsOf(checked.root)) {
    let image: RecordImage | null =
      path.image === "previous" ? images.previous : images.record;

    for (const [index, field] of path.fields.slice(0, -1).entries()) {
      const id = image?.[field.id];

      if (image === null || !isString(id) || field.type.kind !== "reference") {
        break;
      }

      const known = images.live?.get(id) ?? targets.get(id);

      if (known === undefined) {
        const loaded = yield* loadRecord(
          snapshot,
          path.classes[index + 1] ?? field.type.targetClassId,
          id
        );

        image = Option.isSome(loaded) ? imageOf(loaded.value) : null;
        targets.set(id, image);
      } else {
        image = known;
        targets.set(id, known);
      }
    }
  }

  return targets;
});

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
