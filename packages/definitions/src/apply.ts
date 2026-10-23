/**
 * Applying a change set's operations to a snapshot, in memory (Contracts 1.4
 * step 3): load, validate and check versions before any SQL runs.
 *
 * The result is the next snapshot and, per touched definition, its state
 * before and after. A definition touched by several operations of one change
 * set gets one new version. An operation that changes nothing configured
 * (same effective JSON) is dropped, so rerunning an unchanged definition set
 * changes nothing.
 *
 * Every operation passes the protected-definition and ownership guard
 * (`guards.ts`, Contracts 1.8) first; lifecycle operations also pass the
 * dependency checks of Contracts 1.7 (`lifecycle.ts`). The first refusal
 * fails the change set.
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { fail, succeed } from "effect/Result";
import type { Result } from "effect/Result";

import { sameTypeApartFromAllowedRecords } from "./allowed-records.ts";
import {
  checkVersion,
  currentOf,
  decodeAs,
  nextVersion,
  PLAIN_NOTE,
  record,
  startWork,
} from "./apply-work.ts";
import type { ApplyContext, OperationNote, Work } from "./apply-work.ts";
import type {
  Definition,
  DefinitionKind,
  OverrideDraft,
  Owner,
} from "./definition.ts";
import { isActive } from "./definition.ts";
import { typeClassOf } from "./dependencies.ts";
import { guardChange, guardNewDefinition } from "./guards.ts";
import type { DefinitionId } from "./ids.ts";
import {
  deleteDefinition,
  purge,
  reactivate,
  rename,
  retire,
} from "./lifecycle.ts";
import { idInUseRefusal } from "./occupancy.ts";
import { OPERATION_FORMS, UPDATABLE } from "./operation.ts";
import type {
  CreateOperation,
  Operation,
  TargetedOperation,
} from "./operation.ts";
import { DefinitionInvalid, problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import type { ChangeSetRefusal } from "./refusals.ts";
import { LOCAL_ORIGIN, SYSTEM_REQUESTER } from "./requester.ts";
import { runAsRefusal } from "./rule-validation.ts";
import { ConfigSnapshot } from "./snapshot.ts";
import type { SnapshotKey } from "./snapshot.ts";
import {
  apiNameProblems,
  apiTableNameProblems,
  validateSnapshot,
} from "./validate.ts";

export type { ApplyContext, OperationNote } from "./apply-work.ts";

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
  /** One note per operation: cascades, reported dependents, local overrides. */
  readonly notes: readonly OperationNote[];
}

/** Why a change set cannot be applied. */
export type ApplyError = DefinitionInvalid | ChangeSetRefusal;

/**
 * A local edit by the system user, which holds no permission: the default
 * context, and the most restricted one.
 */
export const LOCAL_CONTEXT: ApplyContext = {
  origin: LOCAL_ORIGIN,
  requester: SYSTEM_REQUESTER,
};

const KINDS_WITH_ENFORCEMENT: ReadonlySet<DefinitionKind> = new Set([
  "class",
  "field",
  "override",
  "index",
]);

/** A definition being built from a draft, before it is decoded. */
interface DefinitionCandidate {
  [property: string]: JsonValue;
}

/**
 * The definitions a new definition points at that must be active: its
 * parent class, its own class, a reference target or a condition's class,
 * indexed fields.
 *
 * @param operation - The create operation.
 * @returns The IDs.
 */
const mustBeActive = (
  operation: CreateOperation
): readonly (DefinitionId | null)[] => {
  const { definition } = operation;

  if (definition.kind === "class") {
    return [definition.parentId];
  }

  if (definition.kind === "field") {
    return [definition.classId, typeClassOf(definition.type)];
  }

  return definition.kind === "index"
    ? [definition.classId, ...definition.fieldIds]
    : [];
};

/**
 * Reports what a new definition may not point at: a retired or purged
 * class or field. Existing definitions may keep pointing at retired ones
 * (Contracts 1.6).
 *
 * @param work - The application.
 * @param operation - The create operation.
 */
const checkActiveReferences = (
  work: Work,
  operation: CreateOperation
): void => {
  for (const id of mustBeActive(operation)) {
    const found = id === null ? undefined : currentOf(work, id);

    if (found !== undefined && !isActive(found)) {
      work.problems.push(
        problem(
          "notLive",
          operation.definition.id,
          `It refers to the ${found.kind} ${found.id}, which is ${found.state}.`
        )
      );
    }
  }
};

const create = (work: Work, operation: CreateOperation): void => {
  const { definition } = operation;
  const kind = OPERATION_FORMS[operation.op].creates;

  if (kind === null) {
    return;
  }

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

  if (!guardNewDefinition(work, operation.op, definition)) {
    return;
  }

  checkActiveReferences(work, operation);

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

const changeProblem = (
  current: Definition,
  key: string,
  value: JsonValue
): string | undefined => {
  if (!UPDATABLE[current.kind].includes(key)) {
    return `The property ${key} of a ${current.kind} cannot be changed here.`;
  }

  if (current.kind !== "field" || key !== "required") {
    return undefined;
  }

  if (current.required && value === false) {
    return "A required field cannot be made optional; retire it instead.";
  }

  // A retired field stays optional (Contracts 1.6): reactivate it first.
  return current.state === "retired" && value === true
    ? "A retired field cannot be made required; reactivate it first."
    : undefined;
};

/**
 * Refuses an override that makes a retired field required: a retired
 * field is optional on every class (Contracts 1.6).
 *
 * @param work - The application.
 * @param id - The override's ID.
 * @param fieldId - The overridden field.
 * @param required - The override's `required`.
 * @returns True when the override may proceed.
 */
const overrideKeepsRetiredOptional = (
  work: Work,
  id: DefinitionId,
  fieldId: DefinitionId,
  required: boolean | null
): boolean => {
  if (required !== true || currentOf(work, fieldId)?.state !== "retired") {
    return true;
  }

  work.problems.push(
    problem(
      "unsupportedChange",
      id,
      "A retired field cannot be made required; reactivate it first."
    )
  );

  return false;
};

const firstChangeProblem = (
  current: Definition,
  changes: Readonly<Record<string, JsonValue>>
): string | undefined => {
  if (current.state === "purged") {
    return "A purged definition cannot change.";
  }

  for (const [key, value] of Object.entries(changes)) {
    const found = changeProblem(current, key, value);

    if (found !== undefined) {
      return found;
    }
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

  // The guard first: a protected definition refuses every change but its
  // label and help text, whatever the change is (Contracts 1.8).
  // A name changed through `update` (set loads do this for roles and
  // permissions) follows the ownership rule of `rename`.
  const renamed =
    "name" in operation.changes
      ? guardChange(work, current, "rename")
      : { localOverride: false };

  const allowed =
    renamed === undefined
      ? undefined
      : guardChange(work, current, "update", Object.keys(operation.changes));

  const found =
    allowed === undefined
      ? undefined
      : firstChangeProblem(current, operation.changes);

  if (found !== undefined) {
    work.problems.push(problem("unsupportedChange", current.id, found));

    return;
  }

  const next =
    allowed === undefined
      ? undefined
      : decodeAs(work, current.id, {
          ...current,
          ...operation.changes,
          version: nextVersion(work, current.id),
        });

  if (allowed !== undefined && next !== undefined) {
    record(work, operation, next, {
      ...PLAIN_NOTE,
      localOverride: allowed.localOverride,
    });
  }
};

/**
 * Whether a replacement keeps the definition's owner layer, set and
 * protected flag, which only an `adopt` may change
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

/**
 * Whether a replacement override is the same live override: same class,
 * field, owner and protected flag.
 *
 * @param current - The stored definition.
 * @param next - The replacement draft.
 * @returns True when it may replace it.
 */
const replacesOverride = (
  current: Definition,
  next: OverrideDraft
): boolean => {
  if (current.kind !== "override" || current.state === "purged") {
    return false;
  }

  return (
    current.classId === next.classId &&
    current.fieldId === next.fieldId &&
    sameOwnership(current, next)
  );
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

  if (!replacesOverride(current, definition)) {
    work.problems.push(
      problem(
        "unsupportedChange",
        definition.id,
        "An override keeps its class, field, owner and protected flag."
      )
    );

    return;
  }

  const allowed = guardChange(work, current, "setOverride");

  const next =
    allowed === undefined ||
    !overrideKeepsRetiredOptional(
      work,
      definition.id,
      definition.fieldId,
      definition.required
    )
      ? undefined
      : decodeAs(work, definition.id, {
          ...current,
          ...definition,
          version: nextVersion(work, definition.id),
        });

  if (allowed !== undefined && next !== undefined) {
    record(work, operation, next, {
      ...PLAIN_NOTE,
      localOverride: allowed.localOverride,
    });
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

  if (
    !(
      guardNewDefinition(work, operation.op, definition) &&
      overrideKeepsRetiredOptional(
        work,
        definition.id,
        definition.fieldId,
        definition.required
      )
    )
  ) {
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

const adopt = (
  work: Work,
  operation: Extract<Operation, { readonly op: "adopt" }>
): void => {
  const current = checkVersion(work, operation.id, operation.version);

  if (current === undefined) {
    return;
  }

  if (current.owner.layer === "local" || current.protected) {
    work.problems.push(
      problem(
        "unsupportedChange",
        current.id,
        "Only an unprotected definition of a core or app set can be adopted."
      )
    );

    return;
  }

  const next = decodeAs(work, current.id, {
    ...current,
    owner: { layer: "local" },
    version: nextVersion(work, current.id),
  });

  if (next !== undefined) {
    record(work, operation, next);
  }
};

type LifecycleOp = Exclude<
  TargetedOperation,
  { readonly op: "update" } | { readonly op: "adopt" }
>;

const applyLifecycle = (work: Work, operation: LifecycleOp): void => {
  if (operation.op === "rename") {
    rename(work, operation);
  } else if (operation.op === "retire") {
    retire(work, operation);
  } else if (operation.op === "reactivate") {
    reactivate(work, operation);
  } else if (operation.op === "purge") {
    purge(work, operation);
  } else {
    deleteDefinition(work, operation);
  }
};

const applyOne = (work: Work, operation: Operation): void => {
  if (operation.op === "update") {
    update(work, operation);
  } else if (operation.op === "adopt") {
    adopt(work, operation);
  } else if (operation.op === "setOverride") {
    if (operation.version === null) {
      createOverride(work, operation);
    } else {
      setOverride(work, operation);
    }
  } else if ("definition" in operation) {
    create(work, operation);
  } else {
    applyLifecycle(work, operation);
  }
};

const conditionText = (definition: Definition | undefined): string => {
  if (
    definition?.kind === "accessRule" ||
    definition?.kind === "subscription" ||
    definition?.kind === "savedFilter"
  ) {
    return JSON.stringify(definition.condition);
  }

  // A rule's actions name fields and hold `where` conditions too.
  if (definition?.kind === "recordRule") {
    return JSON.stringify([definition.condition, definition.actions]);
  }

  return definition?.kind === "field" && definition.type.kind === "reference"
    ? JSON.stringify(definition.type.allowedRecords ?? null)
    : "";
};

/**
 * The definitions whose condition this change set stores: new ones and
 * changed conditions. Only these are checked against retired fields.
 *
 * @param changes - The changes.
 * @returns Their IDs.
 */
const newConditions = (
  changes: readonly DefinitionChange[]
): ReadonlySet<DefinitionId> =>
  new Set(
    changes.flatMap(({ before, after }) =>
      before === undefined || conditionText(before) !== conditionText(after)
        ? [after.id]
        : []
    )
  );

// The fields a change set gives a name: created, renamed or live again.
// Only these are checked for API-name clashes (Contracts 10.2).
const namedFields = (
  changes: readonly DefinitionChange[]
): ReadonlySet<DefinitionId> =>
  new Set(
    changes.flatMap(({ before, after }) => {
      if (after.kind !== "field") {
        return [];
      }

      const named =
        before?.kind !== "field" ||
        before.name !== after.name ||
        before.state !== after.state;

      return named ? [after.id] : [];
    })
  );

// The tables a change set gives a API name: created, renamed, live again,
// or in a namespace it renamed (Contracts 10.1).
const namedTables = (
  after: ConfigSnapshot,
  changes: readonly DefinitionChange[]
): ReadonlySet<DefinitionId> => {
  const renamedNamespaces = new Set(
    changes.flatMap(({ before, after: changed }) =>
      changed.kind === "namespace" &&
      before?.kind === "namespace" &&
      before.name !== changed.name
        ? [changed.id]
        : []
    )
  );

  const tables = changes.flatMap(({ before, after: changed }) => {
    if (changed.kind !== "class") {
      return [];
    }

    const named =
      before?.kind !== "class" ||
      before.name !== changed.name ||
      before.state !== changed.state;

    return named ? [changed.id] : [];
  });

  const moved = after
    .all("class")
    .flatMap((table) =>
      renamedNamespaces.has(table.namespaceId) ? [table.id] : []
    );

  return new Set([...tables, ...moved]);
};

const immutableProblems = (
  changes: readonly DefinitionChange[]
): readonly DefinitionProblem[] =>
  changes.flatMap(({ before, after }) => {
    // Only a reference's allowed-records condition may change (decision
    // 0020); the kind, the target and every other setting may not.
    if (
      before?.kind === "field" &&
      after.kind === "field" &&
      !sameTypeApartFromAllowedRecords(before.type, after.type)
    ) {
      return [
        problem(
          "unsupportedChange",
          after.id,
          "A field's type cannot change in v0.1 (only a reference's allowedRecords can); add a new field and retire this one."
        ),
      ];
    }

    if (
      before?.kind === "field" &&
      after.kind === "field" &&
      (before.numberPrefix === null) !== (after.numberPrefix === null)
    ) {
      return [
        problem(
          "unsupportedChange",
          after.id,
          "Auto-numbering cannot be switched on or off for an existing field; add a new auto-numbered field instead."
        ),
      ];
    }

    return [];
  });

/**
 * Applies operations to a snapshot in memory and validates the result.
 * Protected-definition, ownership, permission and dependency checks run
 * first, operation by operation; the first refusal wins.
 *
 * @param snapshot - The configuration the change set starts from.
 * @param operations - The operations, in order.
 * @param key - The revision and change set ID of the result.
 * @param context - Requester and origin; a local edit without permissions
 *   by default.
 * @returns The applied change set, the first refusal, or every problem.
 */
export const applyOperations = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  key: SnapshotKey,
  context: ApplyContext = LOCAL_CONTEXT
): Result<AppliedChangeSet, ApplyError> => {
  // A create whose ID something stored already holds stops the change set
  // before any operation looks at the occupant (Contracts 1.1, 3.6).
  const taken = idInUseRefusal(
    (id) => snapshot.get(id) !== undefined,
    operations
  );

  if (taken !== undefined) {
    return fail(taken);
  }

  const work = startWork(snapshot, key, context, operations);

  for (const operation of operations) {
    applyOne(work, operation);
  }

  const [refusal] = work.refusals;

  if (refusal !== undefined) {
    return fail(refusal);
  }

  const changes = work.order.flatMap((id): DefinitionChange[] => {
    const after = work.current.get(id);

    return after === undefined ? [] : [{ after, before: snapshot.get(id) }];
  });

  const after = snapshot.with(
    key,
    changes.map((change) => change.after)
  );

  const runAs = runAsRefusal({
    after,
    before: snapshot,
    changed: new Set(changes.map((change) => change.after.id)),
    local: context.origin.kind === "local",
    requester: context.requester,
  });

  if (runAs !== undefined) {
    return fail(runAs);
  }

  const problems = [
    ...work.problems,
    ...immutableProblems(changes),
    ...(work.problems.length === 0
      ? [
          ...validateSnapshot(
            after,
            undefined,
            newConditions(changes),
            snapshot
          ),
          ...apiNameProblems(after, namedFields(changes)),
          ...apiTableNameProblems(after, namedTables(after, changes)),
        ]
      : []),
  ];

  if (problems.length > 0) {
    return fail(new DefinitionInvalid({ problems }));
  }

  return succeed({
    after,
    before: snapshot,
    changes,
    notes: work.notes,
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

  const problems = [
    ...validateSnapshot(snapshot),
    ...apiNameProblems(snapshot),
    ...apiTableNameProblems(snapshot),
  ];

  return problems.length > 0
    ? fail(new DefinitionInvalid({ problems }))
    : succeed(snapshot);
};
