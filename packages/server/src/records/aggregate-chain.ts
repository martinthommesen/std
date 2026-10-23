import {
  identSql,
  joinSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
/**
 * Owner chains and their locks (Contracts 2.2 item 3, 4.9).
 *
 * A record's **owner chain** is its owner, that owner's owner, and so on
 * up to the aggregate root. Owner references are required and never
 * change, so an existing record's chain never changes; it is read without
 * locks, then locked aggregate root first, each owner's root row
 * `FOR NO KEY UPDATE`, and read again: a link that is gone by then makes
 * the caller refuse the save (`NotFound` for an update or delete,
 * `InvalidReference` for a create).
 *
 * `lockAggregates` locks several aggregates for one operation (a move, a
 * TMF write of several parts, a batch), ordered by aggregate root ID,
 * each chain root first, so two such operations never wait on each other
 * in opposite orders.
 */
import {
  MAX_AGGREGATE_LEVELS,
  ownerReferenceOf,
} from "@std/definitions/aggregates";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import { recordRelation } from "./relation.ts";
import { loadRoot } from "./save-sql.ts";
import { readRows } from "./sql-run.ts";

/** One owner of a chain. */
export interface ChainLink {
  readonly id: string;
  /** The owner's concrete class. */
  readonly classId: DefinitionId;
}

/**
 * An owner chain: the direct owner first, the aggregate root last. Empty
 * for a record that is no part.
 */
export type OwnerChain = readonly ChainLink[];

/** A record's concrete class and its owner's ID (null for no owner). */
interface Link {
  readonly classId: DefinitionId;
  readonly ownerId: string | null;
}

/**
 * Reads a record's concrete class and, when it is a part, its owner's ID,
 * without locks.
 *
 * @param snapshot - The configuration.
 * @param classId - Any class of the record's hierarchy.
 * @param id - The record ID.
 * @returns The link, or none when no record has the ID.
 */
const readLink = Effect.fn("Records.readOwnerLink")(function* readLink(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  const root = snapshot.root(classId);

  if (root === undefined) {
    return yield* Effect.die(new RangeError(`Unknown class ${classId}`));
  }

  const references = new Map(
    snapshot.subtree(root.id).flatMap((level) => {
      const reference = ownerReferenceOf(snapshot, level.id);

      return reference === undefined
        ? []
        : [[reference.id, reference] as const];
    })
  );

  const columns = [
    sql`${identSql("r", "class_id")}::text AS "class_id"`,
    ...[...references.values()].map(
      (reference) =>
        sql`${identSql("r", reference.name)}::text AS ${identSql(reference.id)}`
    ),
  ];

  const [row] = yield* readRows(
    sql`SELECT ${joinSql(columns, ", ")}
FROM ${recordRelation(snapshot, root.id)} AS ${identSql("r")}
WHERE ${identSql("r", "id")} = ${textParameter(id, "uuid")}`
  );

  const concrete = row?.class_id;

  if (!isString(concrete)) {
    return Option.none<Link>();
  }

  const reference = ownerReferenceOf(snapshot, concrete);
  const owner = reference === undefined ? null : row?.[reference.id];

  return Option.some<Link>({
    classId: concrete,
    ownerId: isString(owner) ? owner : null,
  });
});

/**
 * Reads the owner chain that starts at an owner, without locks: the owner,
 * its owner, up to the aggregate root.
 *
 * @param snapshot - The configuration.
 * @param targetClassId - The owner reference's target class.
 * @param ownerId - The direct owner's ID.
 * @returns The chain, or none when a link is missing.
 */
export const readChain = Effect.fn("Records.readOwnerChain")(
  function* readChain(
    snapshot: ConfigSnapshot,
    targetClassId: DefinitionId,
    ownerId: string
  ) {
    const chain: ChainLink[] = [];

    let next: { classId: DefinitionId; id: string } | null = {
      classId: targetClassId,
      id: ownerId,
    };

    // A valid configuration has at most MAX_AGGREGATE_LEVELS - 1 owners
    // above a part; the bound keeps bad data from looping.
    while (next !== null && chain.length < MAX_AGGREGATE_LEVELS) {
      const link: Option.Option<Link> = yield* readLink(
        snapshot,
        next.classId,
        next.id
      );

      if (Option.isNone(link)) {
        return Option.none<OwnerChain>();
      }

      chain.push({ classId: link.value.classId, id: next.id });

      const reference = ownerReferenceOf(snapshot, link.value.classId);

      next =
        reference !== undefined &&
        reference.type.kind === "reference" &&
        link.value.ownerId !== null
          ? { classId: reference.type.targetClassId, id: link.value.ownerId }
          : null;
    }

    return Option.some<OwnerChain>(chain);
  }
);

/**
 * Locks an owner chain, aggregate root first, each owner's root row
 * `FOR NO KEY UPDATE`, then reads it again.
 *
 * @param snapshot - The configuration.
 * @param chain - The chain as read without locks.
 * @returns The chain after locking, or none when a link is gone.
 */
export const lockChain = Effect.fn("Records.lockOwnerChain")(
  function* lockChain(snapshot: ConfigSnapshot, chain: OwnerChain) {
    for (const link of chain.toReversed()) {
      const locked = yield* loadRoot(
        snapshot,
        link.classId,
        link.id,
        "FOR NO KEY UPDATE"
      );

      if (Option.isNone(locked)) {
        return Option.none<OwnerChain>();
      }
    }

    const [first] = chain;

    return first === undefined
      ? Option.some<OwnerChain>([])
      : yield* readChain(snapshot, first.classId, first.id);
  }
);

/**
 * Reads and locks the owner chain of a part to be created (Contracts 4.9),
 * before the create writes anything.
 *
 * @param snapshot - The configuration.
 * @param classId - The new record's class.
 * @param ownerId - The value of its owner reference, if it has one.
 * @returns The locked chain (empty for a class that is no part), or none
 *   when the owner, or an owner above it, does not exist.
 */
export const lockChainForCreate = Effect.fn("Records.lockChainForCreate")(
  function* lockChainForCreate(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    ownerId: string | null
  ) {
    const reference = ownerReferenceOf(snapshot, classId);

    if (reference?.type.kind !== "reference" || ownerId === null) {
      return Option.some<OwnerChain>([]);
    }

    const chain = yield* readChain(
      snapshot,
      reference.type.targetClassId,
      ownerId
    );

    return Option.isNone(chain)
      ? chain
      : yield* lockChain(snapshot, chain.value);
  }
);

/**
 * Reads and locks the owner chain of an existing record, before the record
 * itself is locked (Contracts 4.9).
 *
 * @param snapshot - The configuration.
 * @param classId - Any class of the record's hierarchy.
 * @param id - The record ID.
 * @returns The locked chain (empty when the record is no part or does not
 *   exist: its own lock reports that), or none when an owner is gone.
 */
export const lockChainOf = Effect.fn("Records.lockChainOf")(
  function* lockChainOf(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    id: string
  ) {
    const link = yield* readLink(snapshot, classId, id);

    if (Option.isNone(link) || link.value.ownerId === null) {
      return Option.some<OwnerChain>([]);
    }

    return yield* lockChainForCreate(
      snapshot,
      link.value.classId,
      link.value.ownerId
    );
  }
);

/** A record an operation will write. */
export interface AggregateMember {
  /** Any class of its hierarchy (an endpoint's class). */
  readonly classId: DefinitionId;
  readonly id: string;
}

/**
 * Locks the aggregates an operation touches before it writes any of them
 * (Contracts 4.9): ordered by aggregate root ID, each chain from its root
 * down. A record that is no part locks itself as the root of its
 * aggregate. Records that do not exist are skipped; their saves report
 * them.
 *
 * @param snapshot - The configuration.
 * @param members - The records (owners or parts) the operation writes.
 * @returns Nothing.
 */
export const lockAggregates = Effect.fn("Records.lockAggregates")(
  function* lockAggregates(
    snapshot: ConfigSnapshot,
    members: readonly AggregateMember[]
  ) {
    const chains: OwnerChain[] = [];

    for (const member of members) {
      const link = yield* readLink(snapshot, member.classId, member.id);

      if (Option.isSome(link)) {
        const self: ChainLink = { classId: link.value.classId, id: member.id };
        const above = yield* readChain(snapshot, link.value.classId, member.id);

        chains.push(Option.isSome(above) ? above.value : [self]);
      }
    }

    const rootOf = (chain: OwnerChain): string => chain.at(-1)?.id ?? "";

    const ordered = chains.toSorted(
      (left, right) =>
        compareIds(rootOf(left), rootOf(right)) ||
        left.length - right.length ||
        compareIds(left[0]?.id ?? "", right[0]?.id ?? "")
    );

    for (const chain of ordered) {
      yield* lockChain(snapshot, chain);
    }
  }
);
