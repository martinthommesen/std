/**
 * Client-chosen IDs (Contracts 1.1): a change set may give a create its
 * own UUID, and an ID already in use (by any definition, override or
 * tombstone, visible to the caller or not) is refused, because IDs are
 * never reused.
 *
 * The refusal depends on occupancy alone: it names the operation and the
 * ID the caller supplied, never the occupant's kind, owner, version,
 * state or visibility, and it comes before anything else looks at the
 * batch, so no later operation can inspect the occupant (the accepted
 * leak of Contracts 3.6 is exactly "this ID is taken").
 */
import type { DefinitionId } from "./ids.ts";
import { OPERATION_FORMS } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { DefinitionInvalid, problem } from "./problems.ts";

/** A create's client-chosen ID and the operation's position. */
export interface CreatedId {
  readonly index: number;
  readonly id: DefinitionId;
}

/**
 * The IDs a change set's creates choose (`OPERATION_FORMS`): every create
 * tag, and `setOverride` without a version.
 *
 * @param operations - The operations, in order.
 * @returns Each create's ID with its operation's index.
 */
export const createdIds = (
  operations: readonly Operation[]
): readonly CreatedId[] =>
  operations.flatMap((operation, index) => {
    const { create } = OPERATION_FORMS[operation.op];

    const creates =
      create === "always" ||
      (create === "versionless" &&
        "version" in operation &&
        operation.version === null);

    return creates && "definition" in operation
      ? [{ id: operation.definition.id, index }]
      : [];
  });

/**
 * The refusal of a change set whose create chooses an ID already in use:
 * the first such create, by operation index.
 *
 * @param inUse - Whether an ID is held by anything stored (a definition,
 *   an override or a tombstone); a boolean, nothing else.
 * @param operations - The operations, in order.
 * @returns `DefinitionInvalid` with one `idInUse` problem, or undefined.
 */
export const idInUseRefusal = (
  inUse: (id: DefinitionId) => boolean,
  operations: readonly Operation[]
): DefinitionInvalid | undefined => {
  const taken = createdIds(operations).find((entry) => inUse(entry.id));

  return taken === undefined
    ? undefined
    : new DefinitionInvalid({
        problems: [
          problem(
            "idInUse",
            taken.id,
            `Operation ${taken.index} creates a definition with ID ${taken.id}, which is already in use; IDs are never reused.`
          ),
        ],
      });
};
