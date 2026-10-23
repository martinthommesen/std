/**
 * Delivery payloads (Contracts 4.3, 4.5, 4.6): built when a delivery runs,
 * from the change entry it names, and filtered for the subscription's
 * identity on the version's own image under current rules.
 *
 * - **The version's own image** is the record as that version left it,
 *   reconstructed from history and the fields' definition revisions alone,
 *   so a payload never depends on the record's state when the delivery
 *   runs. A field's value at version n is:
 *   - the `after` of the latest entry up to n that changed it (for a
 *     delete, the delete entry's `before`, which holds every non-empty
 *     value);
 *   - otherwise, if the field existed when the record was created (the
 *     create entry's schema revision is at or after the field's first
 *     definition revision), its empty value: a create records every
 *     non-empty value;
 *   - otherwise the record predates the field, and Postgres gave the
 *     existing row the field's default when the column was added (false for
 *     a boolean without one): that is the value if version n was written
 *     after the field existed, the record's table is not a platform table
 *     (migrations add their columns, not field definitions) and the field is
 *     not auto-numbered (a backfill step numbered the row);
 *   - otherwise **unknown**: a version written before the field existed, a
 *     backfilled number, a field without a definition revision, history
 *     that does not start with the create entry.
 *
 *   Unknown is never assumed empty. An unknown field is left out of the
 *   image, so it never appears in a payload, and an access-rule condition
 *   that needs it to decide fails closed (below). Fields the current
 *   snapshot no longer describes (purged) are left out.
 * - **Filtered for the identity under current rules**: the identity's
 *   roles now, the current snapshot's access rules, and their conditions
 *   evaluated in TypeScript (`@std/conditions`, the evaluator the
 *   differential test holds equal to the SQL one) on that image, with `me`
 *   = the identity and `now` = the delivery time. The record is visible
 *   when the record read decision holds; a field is readable when it is
 *   visible, known, and its field read decision holds (Contracts 3.2). A
 *   rule condition that no longer checks or resolves, or that reads an
 *   unknown field before its outcome is decided, denies.
 * - Password and secret fields never appear, neither as values nor as the
 *   `{"changed": true}` marker of the change entry (4.3).
 *
 * Config deliveries (subscriptions on `role` and `accessRule`, 4.6) work
 * the same way: their change entries are keyed by the field IDs the core
 * set describes for the definition table.
 */
import type { Decision } from "@std/access/decision";
import { fieldDecision, recordDecision } from "@std/access/rules";
import type { Caller } from "@std/access/rules";
import { checkCondition } from "@std/conditions/check";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import {
  arrayParameter,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import { classViewOf } from "@std/definitions/condition-view";
import type { FieldDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { decodeIn, emptyValue, encodeOut } from "@std/values/codec";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  parseJsonbText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { isPlaintext } from "@std/values/write-only";
import { Effect, Schema } from "effect";

import { definitionOf } from "../catalog/definition-revisions.ts";
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
   * canonical JSON, readable and known fields only.
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
  /** The schema revision the entry's save ran at. */
  readonly schemaRevision: number;
  /** Field ID to `{ before, after }` or `{ changed: true }`. */
  readonly fields: JsonObject;
}

/** How a field came to exist, from its first definition revision. */
export interface FieldOrigin {
  /** The revision that created the field. */
  readonly revision: number;
  /** Its default then (the value `ADD COLUMN` gave existing rows). */
  readonly default: JsonValue | null;
  /** Whether it was auto-numbered then (a backfill step numbered rows). */
  readonly numbered: boolean;
}

const EntryTextSchema = Schema.Struct({
  actor_id: Schema.String,
  fields: Schema.String,
  id: Schema.String,
  kind: ChangeKindSchema,
  occurred_at: Schema.String,
  operation_id: Schema.String,
  record_class_id: Schema.String,
  schema_revision: Schema.FiniteFromString,
  version_text: Schema.FiniteFromString,
});

const decodeEntryText = Schema.decodeUnknownEffect(EntryTextSchema);

const OriginTextSchema = Schema.Struct({
  effective: Schema.String,
  id: Schema.String,
  revision_text: Schema.FiniteFromString,
});

const decodeOriginText = Schema.decodeUnknownEffect(OriginTextSchema);

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
    recordVersion: text.version_text,
    schemaRevision: text.schema_revision,
  };

  return entry;
});

/**
 * The change entries of a record up to and including a version, in version
 * order.
 *
 * @param recordId - The record.
 * @param version - The delivery's version.
 * @returns The entries, the delivery's own last.
 */
export const readEntries = Effect.fn("Outbox.readEntries")(
  function* readEntries(recordId: string, version: number) {
    const rows = yield* readRows(
      sql`SELECT "id"::text AS "id", "operation_id"::text AS "operation_id",
  "record_class_id"::text AS "record_class_id",
  "record_version"::text AS "version_text", "kind",
  "actor_id"::text AS "actor_id", "occurred_at"::text AS "occurred_at",
  "schema_revision"::text AS "schema_revision", "fields"::text AS "fields"
FROM core."change" AS "c"
WHERE "record_id" = ${textParameter(recordId, "uuid")}
  AND "record_version" <= ${textParameter(String(version), "int8")}
ORDER BY "c"."record_version"`
    );

    const entries: StoredEntry[] = [];

    for (const row of rows) {
      entries.push(yield* entryOf(row));
    }

    return entries;
  }
);

/**
 * The fields a payload may carry: live and not write-only.
 *
 * @param snapshot - The current configuration.
 * @param classId - The record's concrete class.
 * @returns The fields.
 */
const payloadFields = (snapshot: ConfigSnapshot, classId: DefinitionId) =>
  snapshot.fields(classId).filter((field) => !isWriteOnly(field.type.kind));

const originOf = Effect.fnUntraced(function* originOf(row: TextRow) {
  const text = yield* decodeOriginText(row).pipe(
    Effect.mapError(() => unreadable("A definition revision does not decode."))
  );

  const definition = definitionOf(text.effective);

  // Not a field: no origin, so its values count as unknown.
  const origin: FieldOrigin | null =
    definition?.kind === "field"
      ? {
          default: definition.default,
          numbered: definition.numberPrefix !== null,
          revision: text.revision_text,
        }
      : null;

  return [text.id, origin] as const;
});

/**
 * The origin of each payload field of a class: its first definition
 * revision. A field without one is left out (its values count as unknown).
 *
 * @param snapshot - The current configuration.
 * @param classId - The record's concrete class.
 * @returns Field ID to origin.
 */
export const readFieldOrigins = Effect.fn("Outbox.readFieldOrigins")(
  function* readFieldOrigins(snapshot: ConfigSnapshot, classId: DefinitionId) {
    const fieldIds = payloadFields(snapshot, classId).map((field) => field.id);

    // Ordered by the bigint column, qualified: the text rendering is
    // aliased differently, so "10" can never sort before "9" (4.4).
    const rows = yield* readRows(
      sql`SELECT DISTINCT ON ("dr"."definition_id") "dr"."definition_id"::text AS "id",
  "dr"."revision"::text AS "revision_text", "dr"."effective"::text AS "effective"
FROM core."definition_revision" AS "dr"
WHERE "dr"."definition_id" = ANY(${arrayParameter(fieldIds, "uuid")})
ORDER BY "dr"."definition_id", "dr"."revision"`
    );

    const origins = new Map<DefinitionId, FieldOrigin>();

    for (const row of rows) {
      const [fieldId, origin] = yield* originOf(row);

      if (origin !== null) {
        origins.set(fieldId, origin);
      }
    }

    return origins;
  }
);

/** A version's image: the fields whose value is known, and the rest. */
export interface VersionImage {
  /** Field ID to canonical JSON. */
  readonly known: ReadonlyMap<DefinitionId, JsonValue>;
  /** Fields whose value at the version cannot be reconstructed. */
  readonly unknown: ReadonlySet<DefinitionId>;
}

const sideOf = (change: JsonValue, side: "before" | "after"): JsonValue =>
  isJsonObject(change) ? (change[side] ?? null) : null;

/**
 * The value `ADD COLUMN` gave rows that existed when the field was added.
 *
 * @param field - The field as the current snapshot has it.
 * @param origin - Its origin.
 * @returns Its default then, in canonical JSON (false for a boolean
 *   without one), or undefined when it does not decode.
 */
const addedValue = (
  field: FieldDefinition,
  origin: FieldOrigin
): JsonValue | undefined => {
  if (origin.default === null) {
    return emptyValue(field.type.kind);
  }

  const decoded = decodeIn(field.type, origin.default);

  return decoded.ok && !isPlaintext(decoded.value)
    ? encodeOut(field.type, decoded.value)
    : undefined;
};

/** Where an unmentioned field's value at a version comes from. */
interface Unmentioned {
  readonly field: FieldDefinition;
  readonly origin: FieldOrigin | undefined;
  /** The entry the version's image is read at (create/update: the last). */
  readonly at: StoredEntry;
  /** The create entry, when history starts with it. */
  readonly created: StoredEntry | undefined;
  readonly platform: boolean;
}

const unmentionedValue = (input: Unmentioned): JsonValue | undefined => {
  const { at, created, field, origin } = input;

  if (origin === undefined) {
    return undefined;
  }

  // A delete entry holds every non-empty value the row had.
  if (at.kind === "delete") {
    return at.schemaRevision >= origin.revision
      ? emptyValue(field.type.kind)
      : undefined;
  }

  if (created === undefined) {
    return undefined;
  }

  // A create entry records every non-empty value of the fields it had.
  if (created.schemaRevision >= origin.revision) {
    return emptyValue(field.type.kind);
  }

  // The record predates the field: the column's added value, if the
  // version was written after the field existed and nothing else wrote it.
  const reconstructible =
    !input.platform && !origin.numbered && at.schemaRevision >= origin.revision;

  return reconstructible ? addedValue(field, origin) : undefined;
};

/**
 * The version's own image in canonical JSON, from the record's entries up
 * to and including it (the last entry is the delivery's) and its fields'
 * origins. See the module comment for the rules.
 *
 * @param snapshot - The current configuration.
 * @param entries - The record's entries in version order.
 * @param origins - The payload fields' origins.
 * @returns The known values and the unknown fields.
 */
export const versionImage = (
  snapshot: ConfigSnapshot,
  entries: readonly StoredEntry[],
  origins: ReadonlyMap<DefinitionId, FieldOrigin>
): VersionImage => {
  const at = entries.at(-1);
  const known = new Map<DefinitionId, JsonValue>();
  const unknown = new Set<DefinitionId>();

  if (at === undefined) {
    return { known, unknown };
  }

  const [first] = entries;

  const startsWithCreate =
    first?.kind === "create" &&
    first.recordVersion === 1 &&
    entries.length === at.recordVersion;

  const mentioned = new Map<DefinitionId, JsonValue>();
  const applied = at.kind === "delete" ? [at] : entries;
  const side = at.kind === "delete" ? "before" : "after";

  for (const entry of applied) {
    for (const [fieldId, change] of Object.entries(entry.fields)) {
      mentioned.set(fieldId, sideOf(change, side));
    }
  }

  const platform = snapshot.class(at.recordClassId)?.storage === "platform";

  for (const field of payloadFields(snapshot, at.recordClassId)) {
    const value = mentioned.has(field.id)
      ? mentioned.get(field.id)
      : unmentionedValue({
          at,
          created: startsWithCreate ? first : undefined,
          field,
          origin: origins.get(field.id),
          platform,
        });

    if (value === undefined) {
      unknown.add(field.id);
    } else {
      known.set(field.id, value);
    }
  }

  return { known, unknown };
};

/**
 * The known fields as a record image for the evaluator. Unknown fields are
 * absent, so a condition that reads one throws and denies.
 *
 * @param snapshot - The current configuration.
 * @param classId - The record's concrete class.
 * @param json - The known values in canonical JSON.
 * @returns The image, or `PayloadUnreadable`.
 */
export const decodedImage = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  json: ReadonlyMap<DefinitionId, JsonValue>
): RecordImage | PayloadUnreadable => {
  const image: Record<string, NonNullable<RecordImage[string]> | null> = {};

  for (const field of payloadFields(snapshot, classId)) {
    const value = json.get(field.id);

    if (value !== undefined) {
      const decoded = decodeIn(field.type, value);

      if (!decoded.ok) {
        return unreadable(
          `A stored value of field ${field.id} does not decode under the current schema.`
        );
      }

      image[field.id] = decoded.value;
    }
  }

  return image;
};

/**
 * Whether a decision holds on an image, in TypeScript. A condition that no
 * longer checks or resolves, or that meets a defect (such as a field the
 * image does not hold), denies (fail closed, like the SQL compiler's
 * `FALSE`).
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
 * Fields the image does not hold are never readable.
 *
 * @param snapshot - The current configuration.
 * @param caller - The identity's roles.
 * @param classId - The record's concrete class.
 * @param image - The version's own image (known fields only).
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

    if (
      Object.hasOwn(image, field.id) &&
      decisionHolds(snapshot, decision, classId, image, context)
    ) {
      fields.add(field.id);
    }
  }

  return { fields, visible };
};

/**
 * The payload of one delivery from its record's entries, filtered for a
 * caller (pure: the entries and origins are read by `readEntries` and
 * `readFieldOrigins`).
 *
 * @param snapshot - The current configuration.
 * @param caller - The identity's roles.
 * @param input - The record, its entries up to the delivery's (last), and
 *   its fields' origins.
 * @param context - `me` (the identity), `now` and the instance time zone.
 * @returns The payload, or `PayloadUnreadable`.
 */
export const payloadOf = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  input: {
    readonly recordId: string;
    readonly entries: readonly StoredEntry[];
    readonly origins: ReadonlyMap<DefinitionId, FieldOrigin>;
  },
  context: AccessContext
): DeliveryPayload | PayloadUnreadable => {
  const entry = input.entries.at(-1);

  if (entry === undefined) {
    return unreadable("The delivery's change entry does not exist.");
  }

  if (snapshot.class(entry.recordClassId) === undefined) {
    return unreadable(
      `Class ${entry.recordClassId} of the change is not in the configuration.`
    );
  }

  const { known } = versionImage(snapshot, input.entries, input.origins);
  const image = decodedImage(snapshot, entry.recordClassId, known);

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

  const shown = (fieldId: DefinitionId) => readable.fields.has(fieldId);

  return {
    actorId: readable.visible ? entry.actorId : null,
    changeId: entry.changeId,
    changes: Object.fromEntries(
      Object.entries(entry.fields).filter(([fieldId]) => shown(fieldId))
    ),
    classId: entry.recordClassId,
    image: Object.fromEntries([...known].filter(([fieldId]) => shown(fieldId))),
    kind: entry.kind,
    occurredAt: entry.occurredAt,
    operationId: entry.operationId,
    recordId: input.recordId,
    recordVersion: entry.recordVersion,
    visible: readable.visible,
  };
};
