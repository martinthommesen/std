/**
 * Aggregate ownership in the class graph (Contracts 4.9, 6.5): owner
 * references, part classes, and the definition checks of the graph.
 *
 * - An **owner reference** is a reference field declared `aggregate: true`.
 *   The records of its class (and of every descendant, which inherits it)
 *   are **parts**; the record it names is their **owner**.
 * - A class has at most one owner reference, inherited ones included
 *   (`aggregateSecondOwner`).
 * - The class graph of owner references has no cycle (`aggregateCycle`)
 *   and is at most 3 levels deep (`aggregateTooDeep`): an aggregate root,
 *   its parts, and their parts. A part's owner may be of the reference's
 *   target class or any descendant of it, so a class's chain continues
 *   through every class of the target's subtree that is itself a part.
 * - Neither a part class nor an owner reference's target may be a
 *   platform table, whose rows never pass the record service.
 *
 * Every function here is a pure function of the snapshot; the owner
 * references of a snapshot are computed once and cached.
 */
import { isOwnerReferenceType } from "@std/values/field-type";

import type { FieldDefinition } from "./definition.ts";
import { isLive } from "./definition.ts";
import { compareIds } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import { problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/**
 * The most levels of records an aggregate has: the root, its parts and
 * their parts (Contracts 4.9). A chain of owner references is therefore at
 * most {@link MAX_AGGREGATE_LEVELS} - 1 references long.
 */
export const MAX_AGGREGATE_LEVELS = 3;

/** The owner references of a snapshot, by the class that declares them. */
interface OwnerIndex {
  /** Every live owner reference, sorted by ID. */
  readonly all: readonly FieldDefinition[];
  readonly byOwnerClass: Map<DefinitionId, readonly FieldDefinition[]>;
  readonly byClass: ReadonlyMap<DefinitionId, readonly FieldDefinition[]>;
}

const indexes = new WeakMap<ConfigSnapshot, OwnerIndex>();

const ownerIndex = (snapshot: ConfigSnapshot): OwnerIndex => {
  const known = indexes.get(snapshot);

  if (known !== undefined) {
    return known;
  }

  const all = snapshot
    .definitions()
    .flatMap((definition) =>
      definition.kind === "field" &&
      isLive(definition) &&
      isOwnerReferenceType(definition.type)
        ? [definition]
        : []
    )
    .toSorted((left, right) => compareIds(left.id, right.id));

  const byClass = new Map<DefinitionId, FieldDefinition[]>();

  for (const field of all) {
    byClass.set(field.classId, [...(byClass.get(field.classId) ?? []), field]);
  }

  const index: OwnerIndex = { all, byClass, byOwnerClass: new Map() };

  indexes.set(snapshot, index);

  return index;
};

/**
 * The owner references a class has, its own and inherited, root's first.
 * A valid configuration has at most one.
 *
 * @param snapshot - The configuration.
 * @param classId - A class.
 * @returns The owner references.
 */
export const ownerReferencesOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly FieldDefinition[] => {
  const { byClass } = ownerIndex(snapshot);

  return snapshot
    .lineage(classId)
    .flatMap((level) => byClass.get(level.id) ?? []);
};

/**
 * The owner reference of a class (own or inherited): the field that makes
 * its records parts. Undefined for a class whose records are no parts.
 *
 * @param snapshot - The configuration.
 * @param classId - A class.
 * @returns The owner reference, or undefined.
 */
export const ownerReferenceOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): FieldDefinition | undefined => ownerReferencesOf(snapshot, classId)[0];

/**
 * The target class of an owner reference.
 *
 * @param field - An owner reference.
 * @returns Its target class.
 */
export const ownerTargetOf = (field: FieldDefinition): DefinitionId =>
  field.type.kind === "reference" ? field.type.targetClassId : field.classId;

/**
 * The owner references whose records can be parts of a record of a
 * concrete class: those whose target is the class or one of its
 * ancestors.
 *
 * @param snapshot - The configuration.
 * @param ownerClassId - The owner's concrete class.
 * @returns The owner references, sorted by ID.
 */
export const partReferencesOf = (
  snapshot: ConfigSnapshot,
  ownerClassId: DefinitionId
): readonly FieldDefinition[] => {
  const index = ownerIndex(snapshot);
  const known = index.byOwnerClass.get(ownerClassId);

  if (known !== undefined) {
    return known;
  }

  const lineage = new Set(
    snapshot.lineage(ownerClassId).map((level) => level.id)
  );

  const references = index.all.filter((field) =>
    lineage.has(ownerTargetOf(field))
  );

  index.byOwnerClass.set(ownerClassId, references);

  return references;
};

/**
 * Whether records of a class can own parts.
 *
 * @param snapshot - The configuration.
 * @param classId - A concrete class.
 * @returns True when an owner reference targets it or an ancestor.
 */
export const ownsParts = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): boolean => partReferencesOf(snapshot, classId).length > 0;

/**
 * Whether a class is a part class of a rule's class: its owner reference
 * targets that class, one of its ancestors or one of its descendants, so
 * records of the rule's class can own parts of it. This is what an
 * aggregate rule's `anyPart`, `allParts`, `partsChanged`, `setParts` and
 * `createParts` may name (Contracts 4.9, 4.10).
 *
 * @param snapshot - The configuration.
 * @param partClassId - The candidate part class.
 * @param ownerClassId - The aggregate rule's class.
 * @returns True when it is a part class of it.
 */
export const isPartClassOf = (
  snapshot: ConfigSnapshot,
  partClassId: DefinitionId,
  ownerClassId: DefinitionId
): boolean => {
  const reference = ownerReferenceOf(snapshot, partClassId);

  if (reference === undefined) {
    return false;
  }

  const target = ownerTargetOf(reference);

  return (
    snapshot.lineage(ownerClassId).some((level) => level.id === target) ||
    snapshot.subtreeIds(ownerClassId).includes(target)
  );
};

const pushOnce = (
  problems: DefinitionProblem[],
  reported: Set<string>,
  found: DefinitionProblem
): void => {
  const key = `${found.code}:${found.definitionId ?? ""}`;

  if (!reported.has(key)) {
    reported.add(key);
    problems.push(found);
  }
};

const liveClassIds = (snapshot: ConfigSnapshot): readonly DefinitionId[] =>
  snapshot
    .definitions()
    .flatMap((definition) =>
      definition.kind === "class" && isLive(definition) ? [definition.id] : []
    );

const platformProblems = (
  snapshot: ConfigSnapshot,
  field: FieldDefinition
): readonly DefinitionProblem[] => {
  const problems: DefinitionProblem[] = [];

  if (snapshot.class(field.classId)?.storage === "platform") {
    problems.push(
      problem(
        "invalidType",
        field.id,
        "A platform table cannot have an owner reference: its rows never pass the record service."
      )
    );
  }

  if (snapshot.class(ownerTargetOf(field))?.storage === "platform") {
    problems.push(
      problem(
        "invalidType",
        field.id,
        "An owner reference cannot target a platform table: its rows never pass the record service."
      )
    );
  }

  return problems;
};

/** The longest chain of owner references from a class, or a cycle. */
type Depth = number | "cycle";

const chainDepth = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  visiting: Set<DefinitionId>,
  known: Map<DefinitionId, Depth>
): Depth => {
  const done = known.get(classId);

  if (done !== undefined) {
    return done;
  }

  const reference = ownerReferenceOf(snapshot, classId);

  if (reference === undefined) {
    return 0;
  }

  if (visiting.has(classId)) {
    return "cycle";
  }

  visiting.add(classId);

  let deepest = 0;
  let cycle = false;

  for (const owner of snapshot.subtree(ownerTargetOf(reference))) {
    const depth = chainDepth(snapshot, owner.id, visiting, known);

    if (depth === "cycle") {
      cycle = true;
    } else {
      deepest = Math.max(deepest, depth);
    }
  }

  visiting.delete(classId);

  const result: Depth = cycle ? "cycle" : deepest + 1;

  known.set(classId, result);

  return result;
};

/**
 * The problems of the aggregate graph of a whole configuration (Contracts
 * 4.9): a second owner reference on a class, a cycle, a chain deeper than
 * {@link MAX_AGGREGATE_LEVELS} levels, and owner references on or to
 * platform tables. Each is reported on the owner reference concerned.
 *
 * @param snapshot - The configuration after a change.
 * @returns The problems, sorted by definition.
 */
export const aggregateProblems = (
  snapshot: ConfigSnapshot
): readonly DefinitionProblem[] => {
  const { all } = ownerIndex(snapshot);

  if (all.length === 0) {
    return [];
  }

  const problems: DefinitionProblem[] = [];
  const reported = new Set<string>();

  for (const field of all) {
    for (const found of platformProblems(snapshot, field)) {
      pushOnce(problems, reported, found);
    }
  }

  const known = new Map<DefinitionId, Depth>();

  for (const classId of liveClassIds(snapshot)) {
    const [first, ...others] = ownerReferencesOf(snapshot, classId);

    for (const second of others) {
      pushOnce(
        problems,
        reported,
        problem(
          "aggregateSecondOwner",
          second.id,
          `The class ${classId} has a second owner reference: a class has at most one, inherited ones included. Split it into two classes.`
        )
      );
    }

    const depth =
      first === undefined ? 0 : chainDepth(snapshot, classId, new Set(), known);

    if (first !== undefined && depth === "cycle") {
      pushOnce(
        problems,
        reported,
        problem(
          "aggregateCycle",
          first.id,
          "The owner references form a cycle: a record would own itself through its parts."
        )
      );
    } else if (
      first !== undefined &&
      depth !== "cycle" &&
      depth > MAX_AGGREGATE_LEVELS - 1
    ) {
      pushOnce(
        problems,
        reported,
        problem(
          "aggregateTooDeep",
          first.id,
          `An aggregate is at most ${MAX_AGGREGATE_LEVELS} levels deep: a root, its parts and their parts.`
        )
      );
    }
  }

  return problems.toSorted((left, right) =>
    compareIds(left.definitionId ?? "", right.definitionId ?? "")
  );
};
