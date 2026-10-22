import type { Decision } from "@std/access/decision";
/**
 * Delivery payloads (Contracts 4.3, 4.5, 4.6): built when a delivery runs,
 * from the change entry it names, and filtered for the subscription's
 * identity on the version's own image under current rules.
 *
 * - **The version's own image** is the record as that version left it: for
 *   a create or an update, the fold of the record's change entries up to
 *   and including the version (a create records every non-empty value, an
 *   update every changed one); for a delete, the entry's `before` values.
 *   It is read from history alone, so a payload never depends on the
 *   record's state when the delivery runs. Fields the current snapshot no
 *   longer describes (purged) are left out; a field no entry mentions holds
 *   its empty value.
 * - **Filtered for the identity under current rules**: the identity's
 *   roles now, the current snapshot's access rules, and their conditions
 *   evaluated in TypeScript (`@std/conditions`, the evaluator the
 *   differential test holds equal to the SQL one) on that image, with `me`
 *   = the identity and `now` = the delivery time. The record is visible
 *   when the record read decision holds; a field is readable when it is
 *   visible and the field read decision holds (Contracts 3.2). A rule
 *   condition that no longer checks or resolves fails closed, as in SQL.
 * - Password and secret fields never appear, neither as values nor as the
 *   `{"changed": true}` marker of the change entry (4.3).
 *
 * Config deliveries (subscriptions on `role` and `accessRule`, 4.6) work
 * the same way: their change entries are keyed by the field IDs the core
 * set describes for the definition table.
 */
import { recordDecision, fieldDecision } from "@std/access/rules";
import type { Caller } from "@std/access/rules";
import { checkCondition } from "@std/conditions/check";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import { classViewOf } from "@std/definitions/condition-view";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { decodeIn, emptyValue } from "@std/values/codec";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  parseJsonbText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { Effect, Schema } from "effect";

import type { AccessContext } from "../records/access-sql.ts";
import { ChangeKindSchema } from "../records/change-entry.ts";
import type { ChangeKind } from "../records/change-entry.ts";
import { readRows } from "../records/sql-run.ts";
import type { TextRow } from "../records/sql-run.ts";
import { isWriteOnly } from "../records/stored-values.ts";

/** What a delivery carries about its change, as its identity may see it. */
export interface DeliveryPayload {
  /** The change entry: the idempotency key of every effect (4.7). */
  readonly changeId: string;
  /** The outermost transaction of the change; consumers group by it. */
  readonly operationId: string;
  readonly recordId: string;
  /** The record's concrete class (the definition table for config kinds). */
  readonly classId: DefinitionId;
  /** The change entry's version (a delete's is the last version + 1). */
  readonly recordVersion: number;
  readonly kind: ChangeKind;
  /** Epoch milliseconds; informational, never an order. */
  readonly occurredAt: number;
  /**
   * Whether the identity may see the record on the version's own image.
   * When false, `actorId` is null and `image` and `changes` are empty.
   */
  readonly visible: boolean;
  /** Who made the change, when `visible`. */
  readonly actorId: string | null;
  /**
   * The version's own image (the before image for a delete): field ID to
   * canonical JSON, readable fields only.
   */
  readonly image: JsonObject;
  /**
   * The entry's changes, field ID to `{ before, after }` in canonical
   * JSON, for the readable fields only.
   */
  readonly changes: JsonObject;
}

/** A stored change entry could not be read as the current schema describes it. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class PayloadUnreadable extends Schema.TaggedError<
  PayloadUnreadable,
  { readonly brand: unique symbol }
>()("PayloadUnreadable", {
  /** What is wrong, naming IDs only, never a value. */
  reason: Schema.String,
}) {
  /**
   * The reason.
   * @returns The message.
   */
  override get message(): string {
    return this.reason;
  }
}

/** One change entry of a record, as the payload builder reads it. */
export interface StoredEntry {
  readonly changeId: string;
  readonly operationId: string;
  readonly recordClassId: DefinitionId;
  readonly recordVersion: number;
  readonly kind: ChangeKind;
  readonly actorId: string;
  readonly occurredAt: number;
  /** Field ID to `{ before, after }` or `{ changed: true }`. */
  readonly fields: JsonObject;
}

const EntryTextSchema = Schema.Struct({
  actor_id: Schema.String,
  fields: Schema.String,
  id: Schema.String,
  kind: ChangeKindSchema,
  occurred_at: Schema.String,
  operation_id: Schema.String,
  record_class_id: Schema.String,
  record_version: Schema.FiniteFromString,
});

const decodeEntryText = Schema.decodeUnknownEffect(EntryTextSchema);

const unreadable = (reason: string) => new PayloadUnreadable({ reason });

const entryOf = Effect.fnUntraced(function* entryOf(row: TextRow) {
  const text = yield* decodeEntryText(row).pipe(
    Effect.mapError(() => unreadable("A change entry row does not decode."))
  );

  const fields = parseJsonbText(text.fields);
  const occurredAt = parseTimestamptzText(text.occurred_at);

  if (!fields.ok || !isJsonObject(fields.value) || !occurredAt.ok) {
    return yield* unreadable(`Change entry ${text.id} is not readable.`);
  }

  const entry: StoredEntry = {
    actorId: text.actor_id,
    changeId: text.id,
    fields: fields.value,
    kind: text.kind,
    occurredAt: occurredAt.value,
    operationId: text.operation_id,
    recordClassId: text.record_class_id,
    recordVersion: text.record_version,
  };

  return entry;
});

/**
 * The change entries of a record up to and including a version, in version
 * order. A delete's own entry is enough for its image, so only it is read.
 *
 * @param recordId - The record.
 * @param version - The delivery's version.
 * @param kind - The delivery's change kind.
 * @returns The entries, the delivery's own last.
 */
export const readEntries = Effect.fn("Outbox.readEntries")(
  function* readEntries(recordId: string, version: number, kind: ChangeKind) {
    const from = kind === "update" ? 1 : version;

    const rows = yield* readRows(
      sql`SELECT "id"::text AS "id", "operation_id"::text AS "operation_id",
  "record_class_id"::text AS "record_class_id",
  "record_version"::text AS "record_version", "kind",
  "actor_id"::text AS "actor_id", "occurred_at"::text AS "occurred_at",
  "fields"::text AS "fields"
FROM core."change"
WHERE "record_id" = ${textParameter(recordId, "uuid")}
  AND "record_version" BETWEEN ${textParameter(String(from), "int8")}
    AND ${textParameter(String(version), "int8")}
ORDER BY "record_version"`
    );

    const entries: StoredEntry[] = [];

    for (const row of rows) {
      entries.push(yield* entryOf(row));
    }

    return entries;
  }
);

const sideOf = (change: JsonValue, side: "before" | "after"): JsonValue =>
  isJsonObject(change) ? (change[side] ?? null) : null;

/**
 * The fields a payload may carry: live and not write-only.
 *
 * @param snapshot - The current configuration.
 * @param classId - The record's concrete class.
 * @returns The fields.
 */
const payloadFields = (snapshot: ConfigSnapshot, classId: DefinitionId) =>
  snapshot.fields(classId).filter((field) => !isWriteOnly(field.type.kind));

/**
 * The version's own image in canonical JSON, from the record's entries up
 * to and including it (the last entry is the delivery's).
 *
 * @param snapshot - The current configuration.
 * @param entries - The record's entries in version order.
 * @returns Field ID to canonical JSON for every payload field.
 */
export const versionImageJson = (
  snapshot: ConfigSnapshot,
  entries: readonly StoredEntry[]
): ReadonlyMap<DefinitionId, JsonValue> => {
  const last = entries.at(-1);

  if (last === undefined) {
    return new Map();
  }

  const fields = payloadFields(snapshot, last.recordClassId);
  const image = new Map<DefinitionId, JsonValue>();

  for (const field of fields) {
    image.set(field.id, emptyValue(field.type.kind));
  }

  const applied = last.kind === "delete" ? [last] : entries;
  const side = last.kind === "delete" ? "before" : "after";

  for (const entry of applied) {
    for (const [fieldId, change] of Object.entries(entry.fields)) {
      if (image.has(fieldId)) {
        image.set(fieldId, sideOf(change, side));
      }
    }
  }

  return image;
};

const decodedImage = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  json: ReadonlyMap<DefinitionId, JsonValue>
): RecordImage | PayloadUnreadable => {
  const image: Record<string, NonNullable<RecordImage[string]> | null> = {};

  for (const field of payloadFields(snapshot, classId)) {
    const decoded = decodeIn(field.type, json.get(field.id) ?? null);

    if (!decoded.ok) {
      return unreadable(
        `A stored value of field ${field.id} does not decode under the current schema.`
      );
    }

    image[field.id] = decoded.value;
  }

  return image;
};

/**
 * Whether a decision holds on an image, in TypeScript. A condition that no
 * longer checks or resolves, or that meets a defect, denies (fail closed,
 * like the SQL compiler's `FALSE`).
 *
 * @param snapshot - The current configuration.
 * @param decision - The decision.
 * @param classId - The record's concrete class.
 * @param image - The record image.
 * @param context - `me`, `now` and the instance time zone.
 * @returns Whether it holds.
 */
export const decisionHolds = (
  snapshot: ConfigSnapshot,
  decision: Decision,
  classId: DefinitionId,
  image: RecordImage,
  context: AccessContext
): boolean => {
  if (decision.kind !== "conditional") {
    return decision.kind === "always";
  }

  const checked = checkCondition(decision.condition, {
    classId,
    profile: "accessRule",
    purpose: "evaluate",
    view: classViewOf(snapshot),
  });

  if (!checked.ok) {
    return false;
  }

  const resolved = resolveCondition(checked.value, {
    me: context.me,
    now: context.now,
    timeZone: context.timeZone,
  });

  if (!resolved.ok) {
    return false;
  }

  try {
    return evaluateCondition(resolved.value, { record: image });
  } catch {
    return false;
  }
};

/** What the identity may read of one version. */
export interface Readability {
  readonly visible: boolean;
  /** Readable payload fields; empty when not visible. */
  readonly fields: ReadonlySet<DefinitionId>;
}

/**
 * What a caller may read of a record image under the snapshot's rules.
 *
 * @param snapshot - The current configuration.
 * @param caller - The identity's roles.
 * @param classId - The record's concrete class.
 * @param image - The version's own image.
 * @param context - `me`, `now` and the instance time zone.
 * @returns Visibility and the readable fields.
 */
export const readabilityOf = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId,
  image: RecordImage,
  context: AccessContext
): Readability => {
  const visible = decisionHolds(
    snapshot,
    recordDecision(snapshot, caller, "read", classId),
    classId,
    image,
    context
  );

  if (!visible) {
    return { fields: new Set(), visible };
  }

  const fields = new Set<DefinitionId>();

  for (const field of payloadFields(snapshot, classId)) {
    const decision = fieldDecision(snapshot, caller, "read", classId, field.id);

    if (decisionHolds(snapshot, decision, classId, image, context)) {
      fields.add(field.id);
    }
  }

  return { fields, visible };
};

/**
 * The payload of one delivery from its record's entries, filtered for a
 * caller (pure: the entries are read by `readEntries`).
 *
 * @param snapshot - The current configuration.
 * @param caller - The identity's roles.
 * @param recordId - The record.
 * @param entries - The record's entries up to the delivery's, which is last.
 * @param context - `me` (the identity), `now` and the instance time zone.
 * @returns The payload, or `PayloadUnreadable`.
 */
export const payloadOf = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  recordId: string,
  entries: readonly StoredEntry[],
  context: AccessContext
): DeliveryPayload | PayloadUnreadable => {
  const entry = entries.at(-1);

  if (entry === undefined) {
    return unreadable("The delivery's change entry does not exist.");
  }

  if (snapshot.class(entry.recordClassId) === undefined) {
    return unreadable(
      `Class ${entry.recordClassId} of the change is not in the configuration.`
    );
  }

  const json = versionImageJson(snapshot, entries);
  const image = decodedImage(snapshot, entry.recordClassId, json);

  if (image instanceof PayloadUnreadable) {
    return image;
  }

  const readable = readabilityOf(
    snapshot,
    caller,
    entry.recordClassId,
    image,
    context
  );

  const visibleJson = (fieldId: DefinitionId) => readable.fields.has(fieldId);

  return {
    actorId: readable.visible ? entry.actorId : null,
    changeId: entry.changeId,
    changes: Object.fromEntries(
      Object.entries(entry.fields).filter(([fieldId]) => visibleJson(fieldId))
    ),
    classId: entry.recordClassId,
    image: Object.fromEntries(
      [...json].filter(([fieldId]) => visibleJson(fieldId))
    ),
    kind: entry.kind,
    occurredAt: entry.occurredAt,
    operationId: entry.operationId,
    recordId,
    recordVersion: entry.recordVersion,
    visible: readable.visible,
  };
};
