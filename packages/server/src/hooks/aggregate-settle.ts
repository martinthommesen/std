/**
 * Settling aggregates in memory (Contracts 4.9 step 1, 4.10, 5.10): the
 * `aggregate` record rules of every owner in the settling set, innermost
 * first, each owner's rules in rule order, on in-memory images that every
 * proposal updates at once; then, in the same pass, the `derive` rules of
 * every record whose image changed. A pass that proposes nothing is the
 * fixed point; if pass 3 still proposes something, the transaction fails
 * with `AggregateNotSettled`. Nothing is written here: settling only reads
 * (owners, parts, reference targets and `forEach` records, as system).
 *
 * - Conditions are the aggregate-rule profile (`@std/conditions/aggregate`):
 *   the record-rule profile on the owner's current image, with `previous`
 *   its image at the start of the transaction (all empty when the
 *   transaction created it), `partsChanged.C`, `anyPart` and `allParts`,
 *   evaluated in TypeScript only. Reference hops are read as system from
 *   the database.
 * - `set` changes the owner's image; `setParts` the images of its parts
 *   of a class that match `where`; `createParts` proposes new parts (one,
 *   or one per `forEach` record, at most 100, else `AggregateNotSettled`
 *   [judgment]); `refuse` fails the transaction with the rule's error. In
 *   every value, `record.f` and `owner.f` read the owner's image.
 * - A rule declared `once` fires at most once per owner and transaction;
 *   the owner's entry in the touched set records that it fired.
 * - A changed part that owns parts itself is enrolled in the settling set,
 *   so its rules run from the next pass.
 * - `derive` rules run with the record's supplied fields for the
 *   operation (`suppliedFieldsOf`), so `keepSupplied` keeps a value a user
 *   wrote. Guards and invariants do not run while settling.
 */
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { InvalidTransition } from "@std/api/errors/invalid-transition";
import { RuleRefused } from "@std/api/errors/rule-refused";
import {
  aggregatePaths,
  checkAggregateCondition,
  checkPartCondition,
  resolvePartCondition,
  evaluateAggregate,
  partMatches,
  pathsOfNode,
  resolveAggregate,
} from "@std/conditions/aggregate";
import type { ResolvedAggregate } from "@std/conditions/aggregate";
import { ConditionDefectError } from "@std/conditions/defect";
import type { RecordImage } from "@std/conditions/evaluate-core";
import type { ResolvedNode, TypedPath } from "@std/conditions/typed";
import { isPartClassOf, ownerReferenceOf } from "@std/definitions/aggregates";
import type { Condition } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import type { RecordRuleDefinition } from "@std/definitions/definition";
import { effectiveFields } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { absentCreateValue, fieldRulesOf } from "@std/definitions/record-rules";
import { CREATE_PARTS_MAX } from "@std/definitions/rule-definition";
import type {
  RuleAction,
  RuleAssignment,
} from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { storedEquals } from "@std/values/compare";
import type { StoredOrPlaintext } from "@std/values/compare";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import { innermostFirst, partsOf } from "../records/aggregate-images.ts";
import type {
  SettleImage,
  SettleOwner,
  SettleSet,
} from "../records/aggregate-images.ts";
import type { SettleInput } from "../records/save-hooks.ts";
import { loadRecord } from "../records/save-sql.ts";
import { suppliedFieldsOf } from "../records/supplied-fields.ts";
import { applyDeriveRules } from "./before-rules.ts";
import { imageOf } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import { selectForEach, sourceImage } from "./rule-for-each.ts";
import type { RuleRecord } from "./rule-for-each.ts";
import { selectRules } from "./rule-selection.ts";
import { ruleValue } from "./rule-values.ts";
import type { ValueRecord } from "./rule-values.ts";

/** The most passes of one settling (Contracts 4.9). [judgment] */
export const MAX_SETTLE_PASSES = 3;

/** What one settling runs with. */
interface Settling {
  readonly input: SettleInput;
  readonly set: SettleSet;
  readonly snapshot: ConfigSnapshot;
  readonly context: RuleContext;
  /** Resolved conditions by rule ID (and action index for `setParts`). */
  readonly conditions: Map<string, ResolvedAggregate>;
  readonly partConditions: Map<string, ResolvedNode>;
  /** Reference targets read as system, by record ID. */
  readonly targets: Map<string, RecordImage | null>;
  /** The images a proposal changed in the running pass. */
  readonly dirty: Set<string>;
}

const defect = (message: string) =>
  Effect.die(new ConditionDefectError(message));

const startImageOf = (owner: SettleOwner): RecordImage | null =>
  owner.entry.start === null ? null : imageOf(owner.entry.start);

/**
 * Loads the reference targets a path crosses from an image, as system: a
 * missing target reads as an empty reference. A target in the settling
 * set is its settling image, the very object proposals change, so a rule
 * that follows a reference to an owner or part sees every proposal made
 * so far, in this pass and earlier ones; only records outside the
 * settling set are read from the database, once per settling.
 *
 * @param settling - The settling.
 * @param path - The path.
 * @param start - The image it starts from.
 * @returns Nothing; the targets are cached.
 */
const preloadPath = Effect.fn("Aggregates.preloadPath")(function* preload(
  settling: Settling,
  path: TypedPath,
  start: RecordImage | null
) {
  let image = start;

  for (const [index, field] of path.fields.slice(0, -1).entries()) {
    const id = image?.[field.id];

    if (image === null || !isString(id) || field.type.kind !== "reference") {
      return;
    }

    const live = settling.set.images.get(id);

    if (live !== undefined) {
      settling.targets.set(id, live.image);
      ({ image } = live);
      continue;
    }

    const known = settling.targets.get(id);

    if (known === undefined) {
      const loaded = yield* loadRecord(
        settling.snapshot,
        path.classes[index + 1] ?? field.type.targetClassId,
        id
      );

      image = Option.isSome(loaded) ? imageOf(loaded.value) : null;
      settling.targets.set(id, image);
    } else {
      image = known;
    }
  }
});

const ruleConditionOf = (
  settling: Settling,
  rule: RecordRuleDefinition
): ResolvedAggregate | undefined => {
  const known = settling.conditions.get(rule.id);

  if (known !== undefined || rule.condition === null) {
    return known;
  }

  const { snapshot } = settling;

  const checked = checkAggregateCondition(rule.condition, {
    classId: rule.classId,
    isPartClass: (classId) => isPartClassOf(snapshot, classId, rule.classId),
    purpose: "evaluate",
    view: classViewOf(snapshot),
  });

  if (!checked.ok) {
    throw new ConditionDefectError(
      "A stored aggregate-rule condition does not check against the configuration."
    );
  }

  const resolved = resolveAggregate(checked.value, settling.context);

  if (!resolved.ok) {
    throw new ConditionDefectError(
      "An aggregate-rule condition does not resolve."
    );
  }

  settling.conditions.set(rule.id, resolved.value);

  return resolved.value;
};

const holds = Effect.fn("Aggregates.ruleHolds")(function* holds(
  settling: Settling,
  owner: SettleOwner,
  rule: RecordRuleDefinition
) {
  const condition = ruleConditionOf(settling, rule);

  if (condition === undefined) {
    return true;
  }

  const previous = startImageOf(owner);

  for (const found of aggregatePaths(condition.root)) {
    if (found.on === "owner") {
      yield* preloadPath(settling, found.path, owner.image.image);
      yield* preloadPath(settling, found.path, previous);
    } else if (found.classId !== null) {
      for (const part of partsOf(settling.set, owner, found.classId)) {
        yield* preloadPath(settling, found.path, part.image);
      }
    }
  }

  return evaluateAggregate(condition, {
    owner: owner.image.image,
    parts: (classId) =>
      partsOf(settling.set, owner, classId).map((part) => part.image),
    partsChanged: (classId) => {
      const subtree = new Set(settling.snapshot.subtreeIds(classId));

      return [...owner.entry.partClasses].some((partClass) =>
        subtree.has(partClass)
      );
    },
    previous,
    targets: settling.targets,
  });
});

/**
 * Sets a value on an image when it differs.
 *
 * @param settling - The settling.
 * @param target - The image.
 * @param assignment - The field and its value form.
 * @param sources - What the value reads.
 * @param ruleId - The proposing rule.
 * @returns True when the image changed.
 */
const assign = (
  settling: Settling,
  target: SettleImage,
  assignment: RuleAssignment,
  sources: { readonly owner: ValueRecord; readonly source: ValueRecord | null },
  ruleId: DefinitionId
): boolean => {
  const field = settling.snapshot.field(assignment.fieldId);

  if (field === undefined) {
    throw new RangeError(`Rule field ${assignment.fieldId} is unknown.`);
  }

  const value: StoredOrPlaintext = ruleValue(assignment, field.type, {
    me: settling.context.me,
    now: settling.context.now,
    owner: sources.owner,
    record: sources.owner,
    source: sources.source,
  });

  const current = target.image[assignment.fieldId] ?? null;

  if (storedEquals(field.type.kind, current, value)) {
    return false;
  }

  target.image[assignment.fieldId] = value;
  target.rules.add(ruleId);
  settling.dirty.add(target.key);

  return true;
};

const ownerRecord = (owner: SettleOwner): RuleRecord => ({
  id: owner.entry.id,
  image: owner.image.image,
});

const partConditionOf = (
  settling: Settling,
  key: string,
  partClassId: DefinitionId,
  ownerClassId: DefinitionId,
  where: Condition
): ResolvedNode => {
  const known = settling.partConditions.get(key);

  if (known !== undefined) {
    return known;
  }

  const checked = checkPartCondition(where, partClassId, ownerClassId, {
    purpose: "evaluate",
    view: classViewOf(settling.snapshot),
  });

  const resolved = checked.ok
    ? resolvePartCondition(checked.value, settling.context)
    : undefined;

  if (resolved === undefined || !resolved.ok) {
    throw new ConditionDefectError(
      "A stored setParts condition does not check against the configuration."
    );
  }

  settling.partConditions.set(key, resolved.value.root);

  return resolved.value.root;
};

const setParts = Effect.fn("Aggregates.setParts")(function* setParts(
  settling: Settling,
  owner: SettleOwner,
  rule: RecordRuleDefinition,
  action: Extract<RuleAction, { readonly type: "setParts" }>,
  index: number
) {
  const parts = partsOf(settling.set, owner, action.classId);
  let changed = false;

  const where =
    action.where === null
      ? null
      : partConditionOf(
          settling,
          `${rule.id}:${index}`,
          action.classId,
          rule.classId,
          action.where
        );

  if (where !== null) {
    for (const path of pathsOfNode(where)) {
      const starts =
        path.scope === "owner"
          ? [owner.image.image, startImageOf(owner)]
          : parts.map((part) => part.image);

      for (const start of starts) {
        yield* preloadPath(settling, path, start);
      }
    }
  }

  for (const part of parts) {
    const matches =
      where === null ||
      partMatches(where, part.image, {
        owner: owner.image.image,
        previous: startImageOf(owner),
        targets: settling.targets,
      });

    if (matches) {
      for (const assignment of action.values) {
        changed =
          assign(
            settling,
            part,
            assignment,
            { owner: ownerRecord(owner), source: null },
            rule.id
          ) || changed;
      }

      if (settling.dirty.has(part.key)) {
        yield* settling.input.enroll(part);
      }
    }
  }

  return changed;
});

/**
 * A proposed part's image: every field of its class at the value a create
 * stores without it (its default, else empty), its owner reference naming
 * the owner.
 *
 * @param settling - The settling.
 * @param classId - The part class.
 * @param owner - The owner.
 * @returns The image.
 */
const newPartImage = (
  settling: Settling,
  classId: DefinitionId,
  owner: SettleOwner
): SettleImage => {
  const { snapshot } = settling;
  const image: Record<DefinitionId, StoredOrPlaintext> = {};

  for (const effective of effectiveFields(snapshot, classId)) {
    image[effective.field.id] =
      effective.state === "active"
        ? absentCreateValue(fieldRulesOf(snapshot, effective))
        : null;
  }

  const reference = ownerReferenceOf(snapshot, classId);

  if (reference !== undefined) {
    image[reference.id] = owner.entry.id;
  }

  settling.set.proposed.count += 1;

  return {
    classId,
    id: null,
    image,
    key: `new:${settling.set.proposed.count}`,
    ownerKey: owner.image.key,
    rules: new Set(),
    stored: null,
  };
};

const createParts = Effect.fn("Aggregates.createParts")(function* createParts(
  settling: Settling,
  owner: SettleOwner,
  rule: RecordRuleDefinition,
  action: Extract<RuleAction, { readonly type: "createParts" }>
) {
  const sources: (ValueRecord | null)[] = [];

  if (action.forEach === null) {
    sources.push(null);
  } else {
    const selected = yield* selectForEach(
      {
        context: settling.context,
        record: ownerRecord(owner),
        ruleClassId: rule.classId,
        snapshot: settling.snapshot,
      },
      action.forEach
    );

    if (selected.length > CREATE_PARTS_MAX) {
      return yield* new AggregateNotSettled();
    }

    for (const record of selected) {
      sources.push(yield* sourceImage(settling.snapshot, record));
    }
  }

  for (const source of sources) {
    const part = newPartImage(settling, action.classId, owner);

    for (const assignment of action.values) {
      assign(
        settling,
        part,
        assignment,
        { owner: ownerRecord(owner), source },
        rule.id
      );
    }

    part.rules.add(rule.id);
    settling.dirty.add(part.key);
    settling.set.images.set(part.key, part);
    owner.parts.push(part.key);
  }

  return sources.length > 0;
});

const refusalOf = (action: Extract<RuleAction, { readonly type: "refuse" }>) =>
  action.code === "InvalidTransition"
    ? new InvalidTransition({ message: action.message })
    : new RuleRefused({ message: action.message });

/**
 * Runs one rule's actions on an owner.
 *
 * @param settling - The settling.
 * @param owner - The owner.
 * @param rule - The rule, whose condition holds.
 * @returns True when an action proposed something.
 */
const runActions = Effect.fn("Aggregates.runActions")(function* runActions(
  settling: Settling,
  owner: SettleOwner,
  rule: RecordRuleDefinition
) {
  let proposed = false;

  for (const [index, action] of rule.actions.entries()) {
    switch (action.type) {
      case "set": {
        for (const assignment of action.values) {
          proposed =
            assign(
              settling,
              owner.image,
              assignment,
              { owner: ownerRecord(owner), source: null },
              rule.id
            ) || proposed;
        }

        break;
      }

      case "refuse": {
        return yield* refusalOf(action);
      }

      case "setParts": {
        proposed =
          (yield* setParts(settling, owner, rule, action, index)) || proposed;
        break;
      }

      case "createParts": {
        proposed =
          (yield* createParts(settling, owner, rule, action)) || proposed;
        break;
      }

      case "updateEach":
      case "createEach": {
        return yield* defect(`An aggregate rule cannot run ${action.type}.`);
      }

      default: {
        return yield* defect("Unknown action.");
      }
    }
  }

  return proposed;
});

/**
 * The `derive` rules of one changed image, as the save that persists it
 * would run them (4.9): on the settled image, `previous` the stored
 * record, the operation's supplied fields.
 *
 * @param settling - The settling.
 * @param image - The changed image.
 * @returns True when they changed it further.
 */
const derive = Effect.fn("Aggregates.derive")(function* derive(
  settling: Settling,
  image: SettleImage
) {
  const derived = yield* applyDeriveRules({
    classId: image.classId,
    context: settling.context,
    image: image.image,
    live: new Map(
      [...settling.set.images.values()].flatMap((other) =>
        other.id === null ? [] : [[other.id, other.image] as const]
      )
    ),
    operation: image.stored === null ? "create" : "update",
    previous: image.stored === null ? null : imageOf(image.stored),
    snapshot: settling.snapshot,
    supplied: image.id === null ? new Set() : yield* suppliedFieldsOf(image.id),
  });

  let changed = false;

  for (const [fieldId, value] of derived.set) {
    const field = settling.snapshot.field(fieldId);
    const current = image.image[fieldId] ?? null;

    if (field !== undefined && !storedEquals(field.type.kind, current, value)) {
      image.image[fieldId] = value;
      changed = true;
    }
  }

  return changed;
});

/**
 * One pass: every owner's aggregate rules, innermost first, then the
 * `derive` rules of every changed image.
 *
 * @param settling - The settling.
 * @returns True when the pass proposed something.
 */
const runPass = Effect.fn("Aggregates.pass")(function* runPass(
  settling: Settling
) {
  let proposed = false;

  settling.dirty.clear();

  for (const owner of innermostFirst(settling.set)) {
    const rules = selectRules(settling.snapshot, owner.entry.classId, {
      phase: "aggregate",
    });

    for (const rule of rules) {
      const skip = rule.once && owner.entry.fired.has(rule.id);

      if (!skip && (yield* holds(settling, owner, rule))) {
        if (rule.once) {
          owner.entry.fired.add(rule.id);
        }

        proposed = (yield* runActions(settling, owner, rule)) || proposed;
      }
    }
  }

  for (const key of settling.dirty) {
    const image = settling.set.images.get(key);

    if (image !== undefined) {
      proposed = (yield* derive(settling, image)) || proposed;
    }
  }

  return proposed;
});

/**
 * Settles a set of owners to a fixed point (Contracts 4.9 step 1).
 *
 * @param input - The settling set and how to enroll owners.
 * @param context - `me`, `now` and the instance time zone.
 * @returns Nothing; the images hold the settled state. `AggregateNotSettled`
 *   when pass 3 still proposes something.
 */
export const settleAggregates = Effect.fn("Aggregates.settle")(
  function* settleAggregates(input: SettleInput, context: RuleContext) {
    const settling: Settling = {
      conditions: new Map(),
      context,
      dirty: new Set(),
      input,
      partConditions: new Map(),
      set: input.set,
      snapshot: input.set.snapshot,
      targets: new Map(),
    };

    let proposing = true;

    for (let pass = 1; pass <= MAX_SETTLE_PASSES && proposing; pass += 1) {
      proposing = yield* runPass(settling);
    }

    return proposing ? yield* new AggregateNotSettled() : undefined;
  }
);
