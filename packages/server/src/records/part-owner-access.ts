/**
 * A write to a part is a write to its owner (Contracts 3.2, 4.9; decision
 * 0039). Every create, update and delete of a part is authorized against
 * each owner of its chain, up to the aggregate root, after the chain is
 * locked and before the part or its aggregate is written: the acting user
 * must see the owner and may update it, by the owner's record rule for
 * `update` on its state as it now is (no owner field is written, so no
 * field rule applies).
 *
 * - An owner the acting user cannot see is `hidden`: the save answers as
 *   for an unknown ID (`NotFound`; `InvalidReference` on the owner
 *   reference for a create).
 * - A visible owner they may not update is `readOnly`: `NotAllowed` with
 *   `refusedOn: "owner"`.
 * - An owner this transaction created, by the same acting user, needs no
 *   decision: its parts written in that transaction are the content of
 *   that create, which its own checks authorized [judgment].
 *
 * The decisions come from the access layer (`WriteAccess.ownerDecisions`,
 * one statement for every undecided owner of a chain) and are kept per
 * transaction attempt, per access layer and per owner, until a save of
 * that owner in the transaction changes what the decision read: a
 * TMF write of a hundred notes decides its ticket once. The state is
 * keyed by the attempt's handle, like the aggregate state: a retried
 * attempt starts empty, and nothing outlives the transaction.
 */
import { ownsParts } from "@std/definitions/aggregates";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Effect, Option } from "effect";

import { CurrentTransaction } from "../sql/transaction-context.ts";
import type { TransactionHandle } from "../sql/transaction-context.ts";
import type { OwnerChain } from "./aggregate-chain.ts";
import { WriteAccess } from "./write-access.ts";
import type { OwnerDecision, WriteAccessApi } from "./write-access.ts";

/** What the owner check of one part write found. */
export type OwnersOutcome = "allowed" | "hidden" | "refused";

/** The owner-access state of one transaction attempt. */
interface OwnerAccessState {
  /** Decisions by owner ID, then by the access layer that made them. */
  readonly decisions: Map<string, WeakMap<WriteAccessApi, OwnerDecision>>;
  /** The owners this attempt created, with the acting user who did. */
  readonly createdBy: Map<string, string>;
}

const states = new WeakMap<TransactionHandle, OwnerAccessState>();

const stateOf = (transaction: TransactionHandle): OwnerAccessState => {
  const known = states.get(transaction);

  if (known !== undefined) {
    return known;
  }

  const created: OwnerAccessState = {
    createdBy: new Map(),
    decisions: new Map(),
  };

  states.set(transaction, created);

  return created;
};

/**
 * Authorizes a part write against its owner chain (decision 0039).
 *
 * @param snapshot - The configuration.
 * @param chain - The part's owner chain, as locked; empty for no part.
 * @param actorId - The acting user.
 * @returns `allowed`, or why not: a hidden owner wins over a refusing one,
 *   so the answer never says that an owner the caller cannot see exists.
 */
export const authorizeOwners = Effect.fn("Records.authorizeOwners")(
  function* authorizeOwners(
    snapshot: ConfigSnapshot,
    chain: OwnerChain,
    actorId: string
  ) {
    if (chain.length === 0) {
      return "allowed" satisfies OwnersOutcome;
    }

    const access = yield* WriteAccess;
    const transaction = yield* Effect.serviceOption(CurrentTransaction);

    const state = Option.isSome(transaction)
      ? stateOf(transaction.value)
      : undefined;

    const owners = chain.filter(
      (link) => state?.createdBy.get(link.id) !== actorId
    );

    const known = new Map(
      owners.flatMap((link): [string, OwnerDecision][] => {
        const decision = state?.decisions.get(link.id)?.get(access);

        return decision === undefined ? [] : [[link.id, decision]];
      })
    );

    const undecided = owners.filter((link) => !known.has(link.id));

    const fresh =
      undecided.length === 0
        ? new Map<string, OwnerDecision>()
        : yield* access.ownerDecisions({ owners: undecided, snapshot });

    for (const [ownerId, decision] of fresh) {
      const byAccess = state?.decisions.get(ownerId) ?? new WeakMap();

      byAccess.set(access, decision);
      state?.decisions.set(ownerId, byAccess);
    }

    const decisions = new Set(
      owners.map((link) => known.get(link.id) ?? fresh.get(link.id) ?? "hidden")
    );

    if (decisions.has("hidden")) {
      return "hidden" satisfies OwnersOutcome;
    }

    return decisions.has("readOnly")
      ? ("refused" satisfies OwnersOutcome)
      : ("allowed" satisfies OwnersOutcome);
  }
);

/**
 * Records a save for the owner checks of later part writes in its
 * transaction, before its after-write hooks run: a save of an owner drops
 * the decisions made on its earlier state, and a create of an owner by an
 * acting user lets that user write its parts in this transaction.
 *
 * @param snapshot - The configuration.
 * @param save - The record's ID and concrete class, what the save did and
 *   the acting user.
 * @returns Nothing.
 */
export const noteOwnerSave = Effect.fn("Records.noteOwnerSave")(
  function* noteOwnerSave(
    snapshot: ConfigSnapshot,
    save: {
      readonly recordId: string;
      readonly classId: DefinitionId;
      readonly kind: "create" | "update" | "delete";
      readonly actorId: string;
    }
  ) {
    const transaction = yield* Effect.serviceOption(CurrentTransaction);

    if (Option.isNone(transaction) || !ownsParts(snapshot, save.classId)) {
      return;
    }

    const state = stateOf(transaction.value);

    state.decisions.delete(save.recordId);

    if (save.kind === "create") {
      state.createdBy.set(save.recordId, save.actorId);
    }
  }
);
