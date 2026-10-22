/**
 * The bookkeeping of one in-memory application of a change set
 * (`apply.ts`): the definitions touched so far, the problems and refusals
 * found, and the operations that changed something with their notes.
 */
import type { JsonObject } from "@std/values/json-value";
import { isSuccess } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import { DefinitionSchema } from "./definition.ts";
import type { Definition } from "./definition.ts";
import type { Dependent } from "./dependency-conflict.ts";
import { sameEffective } from "./effective-json.ts";
import type { DefinitionId } from "./ids.ts";
import type { Operation } from "./operation.ts";
import { problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import type { ChangeSetRefusal } from "./refusals.ts";
import type { ChangeOrigin, Requester } from "./requester.ts";
import type { ConfigSnapshot, SnapshotKey } from "./snapshot.ts";

/** Who asks for a change set and from where. */
export interface ApplyContext {
  readonly origin: ChangeOrigin;
  readonly requester: Requester;
}

/** What the journal and later workstreams need to know about one operation. */
export interface OperationNote {
  /**
   * Definitions the operation changed besides its target: the fields,
   * indexes and overrides of a purged table, the single-field indexes and
   * overrides of a purged field, the grants of a deleted role.
   */
  readonly cascade: readonly DefinitionId[];
  /** Dependents the 1.7 table reports but allows. */
  readonly reported: readonly Dependent[];
  /**
   * A change by an origin that does not own the definition (a label or
   * help-text change to a protected definition, or a local edit of a
   * shipped one). It is applied to the effective record here; the config
   * service (`editDefinition`, through which the HTTP layer routes such
   * edits) stores it as a `core.config_override` row (Contracts 8.2).
   */
  readonly localOverride: boolean;
}

/** A note with nothing to say. */
export const PLAIN_NOTE: OperationNote = {
  cascade: [],
  localOverride: false,
  reported: [],
};

/** Mutable bookkeeping of one application. */
export interface Work {
  /** The configuration the change set starts from. */
  readonly snapshot: ConfigSnapshot;
  readonly key: SnapshotKey;
  readonly context: ApplyContext;
  readonly current: Map<DefinitionId, Definition>;
  readonly order: DefinitionId[];
  readonly problems: DefinitionProblem[];
  readonly refusals: ChangeSetRefusal[];
  readonly applied: Operation[];
  readonly notes: OperationNote[];
  /** The last view built by `viewOf`, and how many changes it includes. */
  view: { readonly changes: number; readonly snapshot: ConfigSnapshot };
  changeCount: number;
}

/**
 * Starts an application.
 *
 * @param snapshot - The configuration the change set starts from.
 * @param key - The revision and change set ID of the result.
 * @param context - Requester and origin.
 * @returns Fresh bookkeeping.
 */
export const startWork = (
  snapshot: ConfigSnapshot,
  key: SnapshotKey,
  context: ApplyContext
): Work => ({
  applied: [],
  changeCount: 0,
  context,
  current: new Map(),
  key,
  notes: [],
  order: [],
  problems: [],
  refusals: [],
  snapshot,
  view: { changes: 0, snapshot },
});

/**
 * A definition as the change set has left it so far.
 *
 * @param work - The application.
 * @param id - A definition ID.
 * @returns The definition, or undefined.
 */
export const currentOf = (
  work: Work,
  id: DefinitionId
): Definition | undefined => work.current.get(id) ?? work.snapshot.get(id);

/**
 * The configuration with every change so far applied, for checks that
 * look at other definitions (dependents, hierarchy).
 *
 * @param work - The application.
 * @returns The snapshot.
 */
export const viewOf = (work: Work): ConfigSnapshot => {
  if (work.view.changes !== work.changeCount) {
    work.view = {
      changes: work.changeCount,
      snapshot: work.snapshot.with(work.key, work.current.values()),
    };
  }

  return work.view.snapshot;
};

/**
 * The version a touched definition gets: one more than its stored version,
 * or 1 when this change set creates it.
 *
 * @param work - The application.
 * @param id - The definition.
 * @returns The version.
 */
export const nextVersion = (work: Work, id: DefinitionId): number => {
  const stored = work.snapshot.get(id);

  return stored === undefined ? 1 : stored.version + 1;
};

const decodeDefinition = decodeUnknownResult(DefinitionSchema);

/**
 * Decodes a candidate definition, reporting a malformed one.
 *
 * @param work - The application.
 * @param id - The definition's ID, for the problem.
 * @param candidate - The candidate.
 * @returns The definition, or undefined.
 */
export const decodeAs = (
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

const put = (work: Work, next: Definition): void => {
  if (!work.current.has(next.id)) {
    work.order.push(next.id);
  }

  work.current.set(next.id, next);
  work.changeCount += 1;
};

/**
 * Records a changed definition; an operation that changes nothing
 * configured (same effective JSON) is dropped.
 *
 * @param work - The application.
 * @param operation - The operation.
 * @param next - The definition after it.
 * @param note - What the journal records about it.
 */
export const record = (
  work: Work,
  operation: Operation,
  next: Definition,
  note: OperationNote = PLAIN_NOTE
): void => {
  const previous = currentOf(work, next.id);

  if (previous !== undefined && sameEffective(previous, next)) {
    return;
  }

  put(work, next);
  work.applied.push(operation);
  work.notes.push(note);
};

/**
 * Records a definition changed as a consequence of another operation.
 *
 * @param work - The application.
 * @param next - The definition after the change.
 */
export const recordCascade = (work: Work, next: Definition): void => {
  const previous = currentOf(work, next.id);

  if (previous === undefined || !sameEffective(previous, next)) {
    put(work, next);
  }
};

/**
 * Finds a definition for an operation on it and checks the version it was
 * read at.
 *
 * @param work - The application.
 * @param id - The definition.
 * @param expected - The version the operation names.
 * @returns The definition as the change set has left it, or undefined.
 */
export const checkVersion = (
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

/**
 * Records a refusal; the change set fails with the first one.
 *
 * @param work - The application.
 * @param refusal - The refusal.
 */
export const refuse = (work: Work, refusal: ChangeSetRefusal): void => {
  work.refusals.push(refusal);
};
