/**
 * Finalizing the touched aggregates of a transaction (Contracts 4.9 steps
 * 1 to 3), when the outermost save of an operation has finished its
 * after-write phase and the save stack is empty:
 *
 * 1. **Settle.** The settling set starts as the touched owners. Their
 *    images and parts are loaded, and `SaveHooks.settle` runs the
 *    aggregate rules to a fixed point in memory (`hooks/aggregate-settle`).
 *    Nothing is written before the last settling pass.
 * 2. **Persist.** Innermost first: each changed or proposed part with an
 *    ordinary save as the system effect `aggregate` (mode `settled`: only
 *    `invariant` rules; no write right of the acting user needed, but
 *    validated), then exactly one **aggregate save** of each owner whose
 *    parts or derived state changed: never a no-op, version + 1, one change
 *    entry with only the changed derived fields and the cause
 *    `{kind: "system", aggregate: {reason, parts, rules}}`. An owner whose
 *    parts and derived state did not change is not saved.
 * 3. **Cascades.** After-write rules of those saves may write other
 *    aggregates; their owners are finalized in turn, settle then persist.
 *    An owner is persisted at most once per transaction: a write into one
 *    already persisted is `AggregateNotSettled` (`aggregate-state.ts`).
 *
 * The saves themselves come from the save pipeline, passed in as
 * `PersistOps`, so this module does not import it.
 */
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { ownsParts } from "@std/definitions/aggregates";
import { effectiveFields } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { absentCreateValue, fieldRulesOf } from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { encodeOut } from "@std/values/codec";
import { storedEquals } from "@std/values/compare";
import type { StoredOrPlaintext } from "@std/values/compare";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { isPlaintext } from "@std/values/write-only";
import { Effect, Option } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { CurrentTransaction } from "../sql/transaction-context.ts";
import {
  enrollOwner,
  innermostFirst,
  loadSettleSet,
} from "./aggregate-images.ts";
import type { SettleImage, SettleSet } from "./aggregate-images.ts";
import { aggregateStateOf } from "./aggregate-state.ts";
import type { AggregateState, OwnerEntry } from "./aggregate-state.ts";
import type { ChangeCause } from "./change-entry.ts";
import { SaveHooks } from "./save-hooks.ts";

/** A part create that persistence makes. */
export interface PersistCreate {
  readonly endpointClassId: DefinitionId;
  readonly body: JsonObject;
  readonly cause: ChangeCause;
}

/** A part update or an aggregate save that persistence makes. */
export interface PersistUpdate {
  readonly endpointClassId: DefinitionId;
  readonly id: string;
  readonly expectedVersion: number;
  readonly body: JsonObject;
  readonly cause: ChangeCause;
  /** True for an owner's aggregate save, which is never a no-op. */
  readonly aggregateSave: boolean;
}

/**
 * The saves persistence makes, as the save pipeline provides them: each
 * as the system effect `aggregate` in mode `settled`, inside the running
 * transaction.
 */
export interface PersistOps<E, R> {
  readonly create: (input: PersistCreate) => Effect.Effect<unknown, E, R>;
  readonly update: (input: PersistUpdate) => Effect.Effect<unknown, E, R>;
}

/** Why an owner gets its aggregate save (4.9). */
type AggregateReason = "parts" | "derived" | "both";

const aggregateCause = (
  reason: AggregateReason,
  parts: readonly string[],
  rules: Iterable<DefinitionId>
): ChangeCause => ({
  aggregate: { parts: [...parts], reason, rules: [...rules] },
  kind: "system",
});

const jsonOf = (
  snapshot: ConfigSnapshot,
  fieldId: DefinitionId,
  value: StoredOrPlaintext
): readonly [string, JsonValue] | undefined => {
  const field = snapshot.field(fieldId);

  if (field === undefined || isPlaintext(value)) {
    return undefined;
  }

  return [field.name, encodeOut(field.type, value)];
};

/**
 * The fields of an image that differ from its stored record, as a body.
 *
 * @param snapshot - The configuration.
 * @param image - A settled image of a stored record.
 * @returns The body; empty when nothing changed.
 */
const changedBody = (
  snapshot: ConfigSnapshot,
  image: SettleImage
): JsonObject => {
  const body: Record<string, JsonValue> = {};

  for (const [fieldId, value] of Object.entries(image.image)) {
    const field = snapshot.field(fieldId);
    const stored = image.stored?.values.get(fieldId) ?? null;

    const entry =
      field !== undefined && !storedEquals(field.type.kind, stored, value)
        ? jsonOf(snapshot, fieldId, value)
        : undefined;

    if (entry !== undefined) {
      const [name, json] = entry;

      body[name] = json;
    }
  }

  return body;
};

/**
 * A proposed part's create body: every field whose value differs from
 * what a create stores without it.
 *
 * @param snapshot - The configuration.
 * @param image - The proposed part.
 * @returns The body.
 */
const createBody = (
  snapshot: ConfigSnapshot,
  image: SettleImage
): JsonObject => {
  const body: Record<string, JsonValue> = {};

  for (const effective of effectiveFields(snapshot, image.classId)) {
    const fieldId = effective.field.id;
    const value = image.image[fieldId] ?? null;
    const rules = fieldRulesOf(snapshot, effective);

    const differs =
      effective.state === "active" &&
      !rules.autoNumber &&
      !storedEquals(effective.type.kind, absentCreateValue(rules), value);

    const entry = differs ? jsonOf(snapshot, fieldId, value) : undefined;

    if (entry !== undefined) {
      const [name, json] = entry;

      body[name] = json;
    }
  }

  return body;
};

/**
 * Enrolls a changed part that owns parts in the settling set (4.9).
 *
 * @param set - The settling.
 * @param state - The transaction's aggregate state.
 * @param part - The changed part.
 * @returns Nothing; `AggregateNotSettled` for an owner already persisted.
 */
const enroll = Effect.fn("Aggregates.enroll")(function* enroll(
  set: SettleSet,
  state: AggregateState,
  part: SettleImage
) {
  const { id } = part;

  const enrolled =
    id === null ||
    !ownsParts(set.snapshot, part.classId) ||
    set.owners.some((owner) => owner.entry.id === id);

  if (enrolled) {
    return yield* Effect.void;
  }

  const above = set.owners.find((owner) => owner.image.key === part.ownerKey);

  const entry: OwnerEntry = state.owners.get(id) ?? {
    classId: part.classId,
    fired: new Set(),
    id,
    level: (above?.entry.level ?? 0) + 1,
    partChanges: [],
    partClasses: new Set(),
    start: part.stored,
    status: "touched",
  };

  if (entry.status === "persisted") {
    return yield* new AggregateNotSettled();
  }

  entry.status = "finalizing";
  state.owners.set(id, entry);

  return yield* enrollOwner(set, entry, part.ownerKey);
});

/**
 * Persists one part a settling changed or proposed, as the system effect.
 *
 * @param snapshot - The configuration.
 * @param part - The part's image.
 * @param ops - The pipeline's saves.
 * @returns Nothing.
 */
const persistPart = <E, R>(
  snapshot: ConfigSnapshot,
  part: SettleImage,
  ops: PersistOps<E, R>
): Effect.Effect<unknown, E, R> => {
  const cause = aggregateCause("derived", [], part.rules);

  if (part.stored === null) {
    return ops.create({
      body: createBody(snapshot, part),
      cause,
      endpointClassId: part.classId,
    });
  }

  const body = changedBody(snapshot, part);

  return Object.keys(body).length === 0
    ? Effect.void
    : ops.update({
        aggregateSave: false,
        body,
        cause,
        endpointClassId: part.classId,
        expectedVersion: part.stored.version,
        id: part.stored.id,
      });
};

const persist = Effect.fn("Aggregates.persist")(function* persist<E, R>(
  set: SettleSet,
  ops: PersistOps<E, R>
) {
  const { snapshot } = set;
  const owners = new Set(set.owners.map((owner) => owner.image.key));

  for (const owner of innermostFirst(set)) {
    // A part that owns parts itself is persisted by its own aggregate save.
    for (const key of owner.parts.filter((part) => !owners.has(part))) {
      const part = set.images.get(key);

      if (part !== undefined) {
        yield* persistPart(snapshot, part, ops);
      }
    }

    const { entry, image } = owner;
    const derived = changedBody(snapshot, image);
    const derivedChanged = Object.keys(derived).length > 0;
    const partsChanged = entry.partChanges.length > 0;

    if (derivedChanged || partsChanged) {
      let reason: AggregateReason = derivedChanged ? "derived" : "parts";

      if (derivedChanged && partsChanged) {
        reason = "both";
      }

      yield* ops.update({
        aggregateSave: true,
        body: derived,
        cause: aggregateCause(reason, entry.partChanges, image.rules),
        endpointClassId: entry.classId,
        expectedVersion: image.stored?.version ?? 0,
        id: entry.id,
      });

      entry.status = "persisted";
    } else {
      entry.status = "clean";
    }
  }
});

/**
 * Finalizes the touched aggregates of the running transaction, cascades
 * included (Contracts 4.9). Any failure poisons the transaction, so it
 * never commits, whoever catches the error.
 *
 * @param ops - The pipeline's saves as the system effect `aggregate`.
 * @returns Nothing.
 */
export const finalizeAggregates = <E, R>(ops: PersistOps<E, R>) =>
  Effect.gen(function* finalize() {
    const transaction = yield* Effect.serviceOption(CurrentTransaction);

    if (Option.isNone(transaction)) {
      return;
    }

    const state = aggregateStateOf(transaction.value);

    // Most transactions touch no aggregate: nothing more to read.
    if (state.owners.size === 0) {
      return;
    }

    const hooks = yield* SaveHooks;
    const snapshot = yield* (yield* Catalog).current;

    for (;;) {
      const touched = [...state.owners.values()].filter(
        (entry) => entry.status === "touched"
      );

      if (touched.length === 0) {
        return;
      }

      for (const entry of touched) {
        entry.status = "finalizing";
      }

      const set = yield* loadSettleSet(snapshot, touched);

      yield* hooks.settle({
        enroll: (part) => enroll(set, state, part),
        set,
      });

      yield* persist(set, ops);
    }
  }).pipe(
    Effect.tapError(() =>
      Effect.serviceOption(CurrentTransaction).pipe(
        Effect.flatMap((transaction) =>
          Option.isSome(transaction)
            ? transaction.value.refuseCommit(
                "finalizing the transaction's aggregates failed"
              )
            : Effect.void
        )
      )
    ),
    Effect.withSpan("Aggregates.finalize")
  );
