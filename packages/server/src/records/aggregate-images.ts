import { identSql, sql, textParameter } from "@std/conditions/sql-fragment";
import { partReferencesOf } from "@std/definitions/aggregates";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
/**
 * The in-memory images of a settling (Contracts 4.9): every owner of the
 * settling set with its current record, its parts as locked, and the
 * images that aggregate rules and `derive` rules change in place. A record
 * that is both a part and an owner (a request item, which owns its
 * approvals) has one image, shared by its owner's part list and its own
 * entry, so a proposal is seen by every rule at once.
 *
 * Loading reads only; nothing is written before persistence.
 */
import type { StoredOrPlaintext } from "@std/values/compare";
import { isString } from "@std/values/field-value";
import { Effect, Option } from "effect";

import type { OwnerEntry } from "./aggregate-state.ts";
import { recordRelation } from "./relation.ts";
import { loadRecord, loadRecords } from "./save-sql.ts";
import { readRows } from "./sql-run.ts";
import { imageOf } from "./stored-record.ts";
import type { StoredRecord } from "./stored-record.ts";

/** One record's image while settling. */
export interface SettleImage {
  /** The record ID, or `new:<n>` for a part `createParts` proposes. */
  readonly key: string;
  /** The record ID; null for a proposed part. */
  readonly id: string | null;
  /** Its concrete class. */
  readonly classId: DefinitionId;
  /** The stored record when settling started; null for a proposed part. */
  readonly stored: StoredRecord | null;
  /** Every field of the class by ID, as settled so far. */
  readonly image: Record<DefinitionId, StoredOrPlaintext>;
  /** The key of its direct owner's image; null for an aggregate root. */
  readonly ownerKey: string | null;
  /** The rules that proposed a change of it, in order. */
  readonly rules: Set<DefinitionId>;
}

/** One owner of the settling set. */
export interface SettleOwner {
  readonly entry: OwnerEntry;
  readonly image: SettleImage;
  /** The keys of its parts' images, as locked plus proposed ones. */
  readonly parts: string[];
}

/** Everything a settling works on. */
export interface SettleSet {
  readonly snapshot: ConfigSnapshot;
  /** The owners, in the order they were enrolled. */
  readonly owners: SettleOwner[];
  /** Every image by key. */
  readonly images: Map<string, SettleImage>;
  /** Counts proposed parts, for their keys. */
  readonly proposed: { count: number };
}

const rememberImage = (
  set: SettleSet,
  record: StoredRecord,
  ownerKey: string | null
): SettleImage => {
  const image: SettleImage = {
    classId: record.classId,
    id: record.id,
    image: imageOf(record),
    key: record.id,
    ownerKey,
    rules: new Set(),
    stored: record,
  };

  set.images.set(record.id, image);

  return image;
};

const imageFor = Effect.fn("Records.settleImage")(function* imageFor(
  set: SettleSet,
  classId: DefinitionId,
  id: string,
  ownerKey: string | null
) {
  const known = set.images.get(id);

  if (known !== undefined) {
    return known;
  }

  const loaded = yield* loadRecord(set.snapshot, classId, id);

  if (Option.isNone(loaded)) {
    return yield* Effect.die(
      new Error("A locked record of an aggregate cannot be read")
    );
  }

  return rememberImage(set, loaded.value, ownerKey);
});

/**
 * The parts of an owner as stored: every record whose owner reference
 * names it, of every class whose owner reference targets the owner's
 * class or an ancestor, in ID order per reference.
 *
 * @param set - The settling.
 * @param owner - The owner's image.
 * @returns The parts' keys.
 */
const loadParts = Effect.fn("Records.settleParts")(function* loadParts(
  set: SettleSet,
  owner: SettleImage
) {
  const keys: string[] = [];

  if (owner.id === null) {
    return keys;
  }

  for (const reference of partReferencesOf(set.snapshot, owner.classId)) {
    const rows = yield* readRows(
      sql`SELECT ${identSql("p", "id")}::text AS "id", ${identSql("p", "class_id")}::text AS "class_id"
FROM ${recordRelation(set.snapshot, reference.classId)} AS ${identSql("p")}
WHERE ${identSql("p", reference.name)} = ${textParameter(owner.id, "uuid")}
ORDER BY ${identSql("p", "id")}`
    );

    const parts = rows.flatMap((row) =>
      isString(row.id) && isString(row.class_id)
        ? [{ classId: row.class_id, id: row.id }]
        : []
    );

    const idsByClass = new Map<DefinitionId, string[]>();

    for (const part of parts.filter(
      (candidate) => !set.images.has(candidate.id)
    )) {
      const ids = idsByClass.get(part.classId) ?? [];
      ids.push(part.id);
      idsByClass.set(part.classId, ids);
    }

    const records = new Map<string, StoredRecord>();

    for (const [classId, ids] of idsByClass) {
      for (const [id, record] of yield* loadRecords(
        set.snapshot,
        classId,
        ids
      )) {
        records.set(id, record);
      }
    }

    for (const part of parts) {
      const known = set.images.get(part.id);

      if (known !== undefined) {
        keys.push(known.key);
        continue;
      }

      const record = records.get(part.id);

      if (record === undefined) {
        return yield* Effect.die(
          new Error("A locked record of an aggregate cannot be read")
        );
      }

      keys.push(rememberImage(set, record, owner.key).key);
    }
  }

  return keys;
});

/**
 * Adds an owner to the settling set: its current record and its parts.
 *
 * @param set - The settling.
 * @param entry - The owner's touched-set entry.
 * @param ownerKey - Its own owner's image key, when it is a part.
 * @returns The settling owner.
 */
export const enrollOwner = Effect.fn("Records.enrollOwner")(function* enroll(
  set: SettleSet,
  entry: OwnerEntry,
  ownerKey: string | null
) {
  const image = yield* imageFor(set, entry.classId, entry.id, ownerKey);
  const parts = yield* loadParts(set, image);
  const owner: SettleOwner = { entry, image, parts };

  set.owners.push(owner);

  return owner;
});

/**
 * The settling set of owners, loaded (Contracts 4.9: the owners' current
 * images and their parts as locked).
 *
 * @param snapshot - The configuration.
 * @param entries - The owners to settle.
 * @returns The settling set.
 */
export const loadSettleSet = Effect.fn("Records.loadSettleSet")(
  function* loadSettleSet(
    snapshot: ConfigSnapshot,
    entries: readonly OwnerEntry[]
  ) {
    const set: SettleSet = {
      images: new Map(),
      owners: [],
      proposed: { count: 0 },
      snapshot,
    };

    // Roots first, so a part that is also an owner finds its owner's image.
    for (const entry of entries.toSorted(
      (left, right) => left.level - right.level
    )) {
      yield* enrollOwner(
        set,
        entry,
        set.images.get(entry.id)?.ownerKey ?? null
      );
    }

    return set;
  }
);

/**
 * The settling order: innermost first (Contracts 4.9), then by ID.
 *
 * @param set - The settling.
 * @returns The owners in order.
 */
export const innermostFirst = (set: SettleSet): readonly SettleOwner[] =>
  set.owners.toSorted(
    (left, right) =>
      right.entry.level - left.entry.level ||
      (left.entry.id < right.entry.id ? -1 : 1)
  );

/**
 * The parts of an owner of a class or a descendant.
 *
 * @param set - The settling.
 * @param owner - The owner.
 * @param classId - The part class.
 * @returns Their images.
 */
export const partsOf = (
  set: SettleSet,
  owner: SettleOwner,
  classId: DefinitionId
): readonly SettleImage[] => {
  const subtree = new Set(set.snapshot.subtreeIds(classId));

  return owner.parts.flatMap((key) => {
    const part = set.images.get(key);

    return part !== undefined && subtree.has(part.classId) ? [part] : [];
  });
};
