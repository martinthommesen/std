/**
 * Applying a change set's operations to a snapshot, in memory (Contracts 1.4
 * step 3): load, validate and check versions before any SQL runs.
 *
 * The result is the next snapshot and, per touched definition, its state
 * before and after. A definition touched by several operations of one change
 * set gets one new version. An operation that changes nothing configured
 * (same effective JSON) is dropped, so rerunning an unchanged definition set
 * changes nothing.
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isSuccess, fail, succeed } from "effect/Result";
import type { Result } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import { DefinitionSchema } from "./definition.ts";
import type { Definition, DefinitionKind, Owner } from "./definition.ts";
import { sameEffective } from "./effective-json.ts";
import type { DefinitionId } from "./ids.ts";
import { UPDATABLE } from "./operation.ts";
import type { CreateOperation, Operation } from "./operation.ts";
import { DefinitionInvalid, problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import { ConfigSnapshot } from "./snapshot.ts";
import type { SnapshotKey } from "./snapshot.ts";
import { validateSnapshot } from "./validate.ts";

/** One definition touched by a change set. */
export interface DefinitionChange {
  /** The stored definition, or undefined when the change set creates it. */
  readonly before: Definition | undefined;
  /** The definition after the change set. */
  readonly after: Definition;
}

/** The outcome of applying operations in memory. */
export interface AppliedChangeSet {
  readonly before: ConfigSnapshot;
  readonly after: ConfigSnapshot;
  /** Touched definitions whose effective JSON changed, in first-touch order. */
  readonly changes: readonly DefinitionChange[];
  /** The operations that changed something, in order. */
  readonly operations: readonly Operation[];
}

const KINDS_WITH_ENFORCEMENT: ReadonlySet<DefinitionKind> = new Set([
  "class",
  "field",
  "override",
  "index",
]);

const decodeDefinition = decodeUnknownResult(DefinitionSchema);

const CREATED_KIND: Readonly<Record<CreateOperation["op"], DefinitionKind>> = {
  addField: "field",
  addIndex: "index",
  createAccessRule: "accessRule",
  createClass: "class",
  createGrant: "grant",
  createNamespace: "namespace",
  createPermission: "permission",
  createRole: "role",
  createSubscription: "subscription",
};

/** A definition being built from a draft, before it is decoded. */
interface DefinitionCandidate {
  [property: string]: JsonValue;
}

/** Mutable bookkeeping of one application. */
interface Work {
  readonly snapshot: ConfigSnapshot;
  readonly current: Map<DefinitionId, Definition>;
  readonly order: DefinitionId[];
  readonly problems: DefinitionProblem[];
  readonly applied: Operation[];
}

const currentOf = (work: Work, id: DefinitionId): Definition | undefined =>
  work.current.get(id) ?? work.snapshot.get(id);

// The version a touched definition gets: one more than its stored version,
// or 1 when this change set creates it.
const nextVersion = (work: Work, id: DefinitionId): number => {
  const stored = work.snapshot.get(id);

  return stored === undefined ? 1 : stored.version + 1;
};

const decodeAs = (
  work: Work,
  id: DefinitionId,
  candidate: JsonObject
): Definition | undefined => {
  const decoded = decodeDefinition(candidate);

  if (isSuccess(decoded)) {
    return decoded.success;
  }

  work.problems.push(
    problem(
      "unsupportedChange",
      id,
      `The resulting definition is malformed: ${decoded.failure.message}`
    )
  );

  return undefined;
};

const record = (work: Work, operation: Operation, next: Definition): void => {
  const previous = currentOf(work, next.id);

  if (previous !== undefined && sameEffective(previous, next)) {
    return;
  }

  if (!work.current.has(next.id)) {
    work.order.push(next.id);
  }

  work.current.set(next.id, next);
  work.applied.push(operation);
};

const create = (work: Work, operation: CreateOperation): void => {
  const { definition } = operation;
  const kind = CREATED_KIND[operation.op];

  if (currentOf(work, definition.id) !== undefined) {
    work.problems.push(
      problem(
        "alreadyExists",
        definition.id,
        `A definition with ID ${definition.id} already exists.`
      )
    );

    return;
  }

  const draft: JsonObject = definition;

  const candidate: DefinitionCandidate = {
    ...draft,
    state: "active",
    version: 1,
  };

  if (KINDS_WITH_ENFORCEMENT.has(kind)) {
    candidate.enforcement = "enforced";
    candidate.enforcementNote = null;
  }

  const next = decodeAs(work, definition.id, candidate);

  if (next !== undefined) {
    record(work, operation, next);
  }
};

const checkVersion = (
  work: Work,
  id: DefinitionId,
  expected: number
): Definition | undefined => {
  const stored = currentOf(work, id);

  if (stored === undefined) {
    work.problems.push(
      problem("unknownDefinition", id, `No definition has ID ${id}.`)
    );

    return undefined;
  }

  const storedVersion = work.snapshot.get(id)?.version ?? 1;

  if (storedVersion !== expected) {
    work.problems.push(
      problem(
        "versionConflict",
        id,
        `The definition is at version ${storedVersion}, not ${expected}.`
      )
    );

    return undefined;
  }

  return stored;
};

const changeProblem = (
  current: Definition,
  key: string,
  value: JsonValue
): string | undefined => {
  if (!UPDATABLE[current.kind].includes(key)) {
    return `The property ${key} of a ${current.kind} cannot be changed here.`;
  }

  if (
    current.kind === "field" &&
    key === "required" &&
    current.required &&
    value === false
  ) {
    return "A required field cannot be made optional; retire it instead.";
  }

  return undefined;
};

const update = (
  work: Work,
  operation: Extract<Operation, { readonly op: "update" }>
): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(operation.changes)) {
    const found = changeProblem(current, key, value);

    if (found !== undefined) {
      work.problems.push(problem("unsupportedChange", current.id, found));

      return;
    }
  }

  const next = decodeAs(work, current.id, {
    ...current,
    ...operation.changes,
    version: nextVersion(work, current.id),
  });

  if (next !== undefined) {
    record(work, operation, next);
  }
};

/**
 * Whether a replacement keeps the definition's owner layer, set and
 * protected flag, which only an `adopt` (workstream 1B) may change
 * (Contracts 8.1).
 *
 * @param current - The stored definition.
 * @param next - The replacement.
 * @returns True when owner and flag are unchanged.
 */
const sameOwnership = (
  current: Definition,
  next: { readonly owner: Owner; readonly protected: boolean }
): boolean => {
  if (current.protected !== next.protected) {
    return false;
  }

  if (current.owner.layer === "app" && next.owner.layer === "app") {
    return current.owner.setId === next.owner.setId;
  }

  return current.owner.layer === next.owner.layer;
};

const setOverride = (
  work: Work,
  operation: Extract<Operation, { readonly op: "setOverride" }>
): void => {
  const { definition, version } = operation;
  const current = checkVersion(work, definition.id, version ?? 0);

  if (current === undefined) {
    return;
  }

  if (
    current.kind !== "override" ||
    current.classId !== definition.classId ||
    current.fieldId !== definition.fieldId ||
    !sameOwnership(current, definition)
  ) {
    work.problems.push(
      problem(
        "unsupportedChange",
        definition.id,
        "An override keeps its class, field, owner and protected flag."
      )
    );

    return;
  }

  const next = decodeAs(work, definition.id, {
    ...current,
    ...definition,
    version: nextVersion(work, definition.id),
  });

  if (next !== undefined) {
    record(work, operation, next);
  }
};

const createOverride = (
  work: Work,
  operation: Extract<Operation, { readonly op: "setOverride" }>
): void => {
  const { definition } = operation;

  if (currentOf(work, definition.id) !== undefined) {
    work.problems.push(
      problem(
        "alreadyExists",
        definition.id,
        `A definition with ID ${definition.id} already exists.`
      )
    );

    return;
  }

  const next = decodeAs(work, definition.id, {
    ...definition,
    enforcement: "enforced",
    enforcementNote: null,
    state: "active",
    version: 1,
  });

  if (next !== undefined) {
    record(work, operation, next);
  }
};

const applyOne = (work: Work, operation: Operation): void => {
  if (operation.op === "update") {
    update(work, operation);
  } else if (operation.op === "setOverride") {
    if (operation.version === null) {
      createOverride(work, operation);
    } else {
      setOverride(work, operation);
    }
  } else {
    create(work, operation);
  }
};

const immutableProblems = (
  changes: readonly DefinitionChange[]
): readonly DefinitionProblem[] =>
  changes.flatMap(({ before, after }) => {
    if (
      before?.kind === "field" &&
      after.kind === "field" &&
      JSON.stringify(before.type) !== JSON.stringify(after.type)
    ) {
      return [
        problem(
          "unsupportedChange",
          after.id,
          "A field's type cannot change in v0.1; add a new field and retire this one."
        ),
      ];
    }

    return [];
  });

/**
 * Applies operations to a snapshot in memory and validates the result.
 *
 * @param snapshot - The configuration the change set starts from.
 * @param operations - The operations, in order.
 * @param key - The revision and change set ID of the result.
 * @returns The applied change set, or every problem found.
 */
export const applyOperations = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  key: SnapshotKey
): Result<AppliedChangeSet, DefinitionInvalid> => {
  const work: Work = {
    applied: [],
    current: new Map(),
    order: [],
    problems: [],
    snapshot,
  };

  for (const operation of operations) {
    applyOne(work, operation);
  }

  const changes = work.order.flatMap((id): DefinitionChange[] => {
    const after = work.current.get(id);

    return after === undefined ? [] : [{ after, before: snapshot.get(id) }];
  });

  const after = snapshot.with(
    key,
    changes.map((change) => change.after)
  );

  const problems = [
    ...work.problems,
    ...immutableProblems(changes),
    ...(work.problems.length === 0 ? validateSnapshot(after) : []),
  ];

  if (problems.length > 0) {
    return fail(new DefinitionInvalid({ problems }));
  }

  return succeed({
    after,
    before: snapshot,
    changes,
    operations: work.applied,
  });
};

/**
 * Builds a snapshot from definitions and validates it, for tests and for
 * checking a definition set on its own.
 *
 * @param key - The revision and change set ID.
 * @param definitions - The definitions.
 * @returns The snapshot, or every problem found.
 */
export const validatedSnapshot = (
  key: SnapshotKey,
  definitions: Iterable<Definition>
): Result<ConfigSnapshot, DefinitionInvalid> => {
  const snapshot = ConfigSnapshot.make(key, definitions);
  const problems = validateSnapshot(snapshot);

  return problems.length > 0
    ? fail(new DefinitionInvalid({ problems }))
    : succeed(snapshot);
};
