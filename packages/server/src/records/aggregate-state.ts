/**
 * The touched set of a transaction (Contracts 4.9): the owners to
 * finalize, with what settling needs to know about each.
 *
 * - A save of a part adds every owner of its chain; its direct owner
 *   records the part's class (`partsChanged`) and the save's change ID
 *   (the aggregate save's `cause.aggregate.parts`).
 * - A save of an owner's own fields adds that owner (and, being a part,
 *   its chain). A delete of an owner marks it deleted: its delete entry is
 *   the aggregate's last state, and it is never finalized.
 * - Each owner keeps its image at the start of the transaction (the
 *   aggregate rules' `previous`), captured when it is first touched, and
 *   the `once` rules that already fired for it.
 * - A write into an owner that this transaction already persisted, or
 *   that is being persisted by a save other than finalization's own, is
 *   `AggregateNotSettled` [judgment for the second].
 *
 * The state lives in process memory, keyed by the transaction attempt's
 * handle like the operation ID (`change-entry.ts`): a retried attempt
 * starts empty, and nothing outlives the transaction.
 */
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { ownsParts } from "@std/definitions/aggregates";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Context, Effect, Option } from "effect";

import { CurrentTransaction } from "../sql/transaction-context.ts";
import type { TransactionHandle } from "../sql/transaction-context.ts";
import type { OwnerChain } from "./aggregate-chain.ts";
import type { ChangeKind } from "./change-entry.ts";
import { loadRecord } from "./save-sql.ts";
import type { StoredRecord } from "./stored-record.ts";

/** Where an owner is in finalization. */
export type OwnerStatus =
  /** Written in this transaction and not finalized since. */
  | "touched"
  /** In the settling set of the finalization that runs now. */
  | "finalizing"
  /** Persisted by an aggregate save: no further write may reach it. */
  | "persisted"
  /** Finalized without an aggregate save (nothing changed). */
  | "clean"
  /** Deleted in this transaction: never finalized. */
  | "deleted";

/** One owner of the touched set. */
export interface OwnerEntry {
  readonly id: string;
  /** Its concrete class. */
  readonly classId: DefinitionId;
  /** How many owners are above it: 0 for an aggregate root. */
  readonly level: number;
  status: OwnerStatus;
  /**
   * Its record at the start of the transaction: null when this
   * transaction created it.
   */
  readonly start: StoredRecord | null;
  /** The concrete classes of its parts that saves wrote. */
  readonly partClasses: Set<DefinitionId>;
  /** The change IDs of its parts' writes, in order. */
  readonly partChanges: string[];
  /** The `once` rules that fired for it. */
  readonly fired: Set<DefinitionId>;
}

/** The aggregate state of one transaction attempt. */
export interface AggregateState {
  readonly owners: Map<string, OwnerEntry>;
}

const states = new WeakMap<TransactionHandle, AggregateState>();

/**
 * The aggregate state of a transaction attempt, created on first use.
 *
 * @param transaction - The attempt's handle.
 * @returns Its state.
 */
export const aggregateStateOf = (
  transaction: TransactionHandle
): AggregateState => {
  const known = states.get(transaction);

  if (known !== undefined) {
    return known;
  }

  const created: AggregateState = { owners: new Map() };

  states.set(transaction, created);

  return created;
};

/**
 * How saves of the current fiber finalize aggregates: `deferred` while an
 * aggregate operation (several saves, finalized once at its end) or
 * finalization itself runs. A real default: a save outside both finalizes
 * at its own end when it is the outermost save.
 */
export const AggregateScope = Context.Reference<{
  readonly deferred: boolean;
}>("std/server/AggregateScope", { defaultValue: () => ({ deferred: false }) });

/** A save as the touched set sees it. */
export interface AggregateWrite {
  readonly snapshot: ConfigSnapshot;
  readonly kind: ChangeKind;
  readonly recordId: string;
  /** The record's concrete class. */
  readonly classId: DefinitionId;
  /** The record before the save; null for a create. */
  readonly before: StoredRecord | null;
  /** The record's owner chain, as locked. */
  readonly chain: OwnerChain;
  /** The save's change entry. */
  readonly changeId: string;
  /** Whether finalization itself makes the save (the system effect). */
  readonly finalizing: boolean;
}

const admit = (
  entry: OwnerEntry,
  finalizing: boolean
): Effect.Effect<void, AggregateNotSettled> => {
  const refused =
    entry.status === "persisted" ||
    (entry.status === "finalizing" && !finalizing);

  if (refused) {
    return Effect.fail(new AggregateNotSettled());
  }

  if (entry.status !== "finalizing" && entry.status !== "deleted") {
    entry.status = "touched";
  }

  return Effect.void;
};

const startImage = Effect.fn("Records.aggregateStart")(function* startImage(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  const loaded = yield* loadRecord(snapshot, classId, id);

  return Option.getOrNull(loaded);
});

/**
 * Adds a save to the touched set (Contracts 4.9), right after its change
 * entry is written. Outside a transaction, and for records that are
 * neither parts nor owners, it records nothing.
 *
 * @param write - The save.
 * @returns Nothing; `AggregateNotSettled` for a write into an owner this
 *   transaction persisted.
 */
export const noteAggregateWrite = Effect.fn("Records.noteAggregateWrite")(
  function* noteAggregateWrite(write: AggregateWrite) {
    const transaction = yield* Effect.serviceOption(CurrentTransaction);
    const owner = ownsParts(write.snapshot, write.classId);

    if (Option.isNone(transaction) || (write.chain.length === 0 && !owner)) {
      return;
    }

    const { owners } = aggregateStateOf(transaction.value);

    for (const [index, link] of write.chain.entries()) {
      const known = owners.get(link.id);

      const entry: OwnerEntry = known ?? {
        classId: link.classId,
        fired: new Set(),
        id: link.id,
        level: write.chain.length - 1 - index,
        partChanges: [],
        partClasses: new Set(),
        start: yield* startImage(write.snapshot, link.classId, link.id),
        status: "touched",
      };

      owners.set(link.id, entry);
      yield* admit(entry, write.finalizing);

      if (index === 0) {
        entry.partClasses.add(write.classId);
        entry.partChanges.push(write.changeId);
      }
    }

    if (!owner) {
      return;
    }

    const self = owners.get(write.recordId);

    if (write.kind === "delete") {
      if (self !== undefined) {
        yield* admit(self, write.finalizing);
        self.status = "deleted";
      }

      return;
    }

    const entry: OwnerEntry = self ?? {
      classId: write.classId,
      fired: new Set(),
      id: write.recordId,
      level: write.chain.length,
      partChanges: [],
      partClasses: new Set(),
      start: write.kind === "create" ? null : write.before,
      status: "touched",
    };

    owners.set(write.recordId, entry);
    yield* admit(entry, write.finalizing);
  }
);
