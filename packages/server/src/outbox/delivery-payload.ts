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
import { arrayParameter, sql } from "@std/conditions/sql-fragment";
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
import { decodeRows } from "../sql/rows.ts";

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
  /** A complete non-secret image saved atomically with this entry. */
  readonly image?: JsonObject;
  /** Set-based legacy reconstruction proved history continuous from create. */
  readonly completeFromCreate?: boolean;
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

const OriginTextSchema = Schema.Struct({
  effective: Schema.String,
  id: Schema.String,
  revision_text: Schema.FiniteFromString,
});

const decodeOriginText = Schema.decodeUnknownEffect(OriginTextSchema);

const unreadable = (reason: string) => new PayloadUnreadable({ reason });

const entryOf = Effect.fnUntraced(function* entryOf(
  text: typeof EntryTextSchema.Type
) {
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

const imageEntries = Effect.fnUntraced(function* imageEntries(
  entry: StoredEntry,
  currentText: string,
  previousText: string | null
) {
  const current = parseJsonbText(currentText);
  const previous = parseJsonbText(previousText ?? "null");

  if (!current.ok || !isJsonObject(current.value) || !previous.ok) {
    return yield* unreadable(`Change image ${entry.changeId} is not readable.`);
  }

  const entries: StoredEntry[] = [];

  if (entry.recordVersion > 1) {
    // Retention can remove v-1 while v is pending: undo only changed fields.
    const derived = new Map(Object.entries(current.value));

    for (const [fieldId, change] of Object.entries(entry.fields)) {
      if (isJsonObject(change) && Object.hasOwn(change, "before")) {
        derived.set(fieldId, change.before ?? null);
      } else {
        derived.delete(fieldId);
      }
    }

    entries.push({
      ...entry,
      fields: {},
      image: isJsonObject(previous.value)
        ? previous.value
        : Object.fromEntries(derived),
      kind: "update",
      recordVersion: entry.recordVersion - 1,
    });
  }

  entries.push({ ...entry, image: current.value });

  return entries;
});

/** A record and the version of it a payload is built at. */
export interface EntryTarget {
  readonly recordId: string;
  readonly version: number;
}

/**
 * The key of a target in `readEntriesAt`'s result.
 *
 * @param target - The record and version.
 * @returns `<record ID>@<version>`.
 */
export const entryTargetKey = (target: EntryTarget): string =>
  `${target.recordId}@${target.version}`;

const targetFields = {
  target_id: Schema.String,
  target_version: Schema.FiniteFromString,
};

const targetImageRows = decodeRows(
  Schema.Struct({
    ...EntryTextSchema.fields,
    ...targetFields,
    after_image: Schema.NullOr(Schema.String),
    before_image: Schema.NullOr(Schema.String),
  })
);

const targetLegacyRows = decodeRows(
  Schema.Struct({
    ...EntryTextSchema.fields,
    ...targetFields,
    complete: Schema.Literals(["true", "false"]),
  })
);

const ENTRY_COLUMNS = sql`"c"."id"::text AS "id", "c"."operation_id"::text AS "operation_id",
  "c"."record_class_id"::text AS "record_class_id", "c"."record_version"::text AS "version_text",
  "c"."kind", "c"."actor_id"::text AS "actor_id", "c"."occurred_at"::text AS "occurred_at",
  "c"."schema_revision"::text AS "schema_revision"`;

const targetsOf = (targets: readonly EntryTarget[]) =>
  sql`unnest(${arrayParameter(
    targets.map((target) => target.recordId),
    "uuid"
  )}, ${arrayParameter(
    targets.map((target) => String(target.version)),
    "int8"
  )}) AS "t"("record_id", "version")`;

const groupByTarget = <
  Row extends { readonly target_id: string; readonly target_version: number },
>(
  rows: readonly Row[]
): ReadonlyMap<string, readonly Row[]> => {
  const grouped = new Map<string, Row[]>();

  for (const row of rows) {
    const key = entryTargetKey({
      recordId: row.target_id,
      version: row.target_version,
    });

    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return grouped;
};

type TargetImageRow = Effect.Success<
  ReturnType<typeof targetImageRows>
>[number];

/**
 * One version's entries from its own and its predecessor's rows, when a
 * saved image gives them (as `readEntries` always read them).
 *
 * @param target - The record and version.
 * @param rows - Its rows at the version and the one before.
 * @returns The entries (empty when the version has no entry), or null when
 *   only the legacy reduction can rebuild it.
 */
const entriesFromImages = Effect.fnUntraced(function* entriesFromImages(
  target: EntryTarget,
  rows: readonly TargetImageRow[]
) {
  const row = rows.find(
    (candidate) => candidate.version_text === target.version
  );

  const predecessor = rows.find(
    (candidate) => candidate.version_text === target.version - 1
  );

  if (row === undefined) {
    return [];
  }

  const previousImage = row.before_image ?? predecessor?.after_image ?? null;
  const currentImage = row.kind === "delete" ? previousImage : row.after_image;

  if (currentImage !== null) {
    return yield* imageEntries(
      yield* entryOf(row),
      currentImage,
      previousImage
    );
  }

  if (previousImage === null) {
    return null;
  }

  // Finalize walks versions in order: reuse the image the previous
  // batch/iteration just wrote instead of reducing the history again.
  const previous = parseJsonbText(previousImage);

  if (
    !previous.ok ||
    !isJsonObject(previous.value) ||
    predecessor === undefined
  ) {
    return yield* unreadable(`Previous image of ${row.id} is not readable.`);
  }

  const entries: readonly StoredEntry[] = [
    { ...(yield* entryOf(predecessor)), image: previous.value },
    yield* entryOf(row),
  ];

  return entries;
});

/**
 * Several versions' entries with a constant number of statements, whatever
 * their number, and bounded data per version: each version's entry with its
 * predecessor's image when new saves carry them (Contracts 4.3: one
 * statement for all), and for legacy history (entries the image backfill,
 * migration 0028, has not reached) a reduction in SQL to at most three
 * entries per version (create, the accumulated previous, the requested), in
 * one more statement for all of them. Each version is keyed by record and
 * version (`entryTargetKey`), so two versions of one record never mix.
 *
 * @param targets - The records and versions.
 * @returns Each target's entries, the requested entry last; empty when the
 *   version has no entry.
 */
export const readEntriesAt = Effect.fn("Outbox.readEntriesAt")(
  function* readEntriesAt(targets: readonly EntryTarget[]) {
    const result = new Map<string, readonly StoredEntry[]>();

    const unique = [
      ...new Map(
        targets.map((target) => [entryTargetKey(target), target])
      ).values(),
    ];

    if (unique.length === 0) {
      return result;
    }

    const imaged = groupByTarget(
      yield* readRows(
        sql`SELECT "t"."record_id"::text AS "target_id", "t"."version"::text AS "target_version",
  ${ENTRY_COLUMNS}, "c"."fields"::text AS "fields",
  "i"."before_image"::text AS "before_image", "i"."after_image"::text AS "after_image"
FROM core."change" AS "c"
JOIN ${targetsOf(unique)} ON "c"."record_id" = "t"."record_id"
  AND "c"."record_version" IN ("t"."version" - 1, "t"."version")
LEFT JOIN core."change_image" AS "i" ON "i"."change_id" = "c"."id"
ORDER BY "t"."record_id", "t"."version", "c"."record_version"`
      ).pipe(Effect.flatMap(targetImageRows))
    );

    const legacy: EntryTarget[] = [];

    for (const target of unique) {
      const key = entryTargetKey(target);
      const entries = yield* entriesFromImages(target, imaged.get(key) ?? []);

      if (entries === null) {
        legacy.push(target);
      } else {
        result.set(key, entries);
      }
    }

    if (legacy.length === 0) {
      return result;
    }

    const reduced = groupByTarget(
      yield* readRows(
        sql`WITH history AS MATERIALIZED (
  SELECT "t"."record_id" AS "target_id", "t"."version" AS "target_version", "c".*
  FROM ${targetsOf(legacy)}
  JOIN core."change" AS "c" ON "c"."record_id" = "t"."record_id"
    AND "c"."record_version" <= "t"."version"
), "previous" AS (
  SELECT "target_id", "target_version", max("record_version") AS "version"
  FROM history WHERE "record_version" < "target_version"
  GROUP BY "target_id", "target_version"
), "mentioned" AS (
  SELECT DISTINCT ON ("h"."target_id", "h"."target_version", "f"."key")
    "h"."target_id", "h"."target_version", "f"."key", "f"."value"
  FROM history AS "h" CROSS JOIN LATERAL jsonb_each("h"."fields") AS "f"
  WHERE "h"."record_version" < "h"."target_version"
  ORDER BY "h"."target_id", "h"."target_version", "f"."key", "h"."record_version" DESC
), "accumulated" AS (
  SELECT "target_id", "target_version", jsonb_object_agg("key", "value") AS "fields"
  FROM "mentioned" GROUP BY "target_id", "target_version"
)
SELECT "c"."target_id"::text AS "target_id", "c"."target_version"::text AS "target_version",
  ${ENTRY_COLUMNS},
  (CASE WHEN "c"."record_version" = "p"."version"
    THEN COALESCE("a"."fields", '{}'::jsonb) ELSE "c"."fields" END)::text AS "fields",
  ((SELECT count(*) FROM history AS "h"
    WHERE "h"."target_id" = "c"."target_id" AND "h"."target_version" = "c"."target_version"
      AND "h"."record_version" <= "c"."record_version") = "c"."record_version")::text AS "complete"
FROM history AS "c"
LEFT JOIN "previous" AS "p" ON "p"."target_id" = "c"."target_id"
  AND "p"."target_version" = "c"."target_version"
LEFT JOIN "accumulated" AS "a" ON "a"."target_id" = "c"."target_id"
  AND "a"."target_version" = "c"."target_version"
WHERE "c"."record_version" IN (1, "p"."version", "c"."target_version")
ORDER BY "c"."target_id", "c"."target_version", "c"."record_version"`
      ).pipe(Effect.flatMap(targetLegacyRows))
    );

    for (const target of legacy) {
      const key = entryTargetKey(target);
      const entries: StoredEntry[] = [];

      for (const row of reduced.get(key) ?? []) {
        entries.push({
          ...(yield* entryOf(row)),
          completeFromCreate: row.complete === "true",
        });
      }

      result.set(key, entries);
    }

    return result;
  }
);

/**
 * Read a version and its preceding image with constant round trips. New saves
 * carry complete images; legacy history is reduced in SQL to at most three
 * entries (create, accumulated previous, requested), never one query per entry.
 * @param recordId - The record.
 * @param version - The delivery's version.
 * @returns Image-bearing or compressed entries, the requested entry last.
 */
export const readEntries = Effect.fn("Outbox.readEntries")(
  function* readEntries(recordId: string, version: number) {
    const target = { recordId, version };
    const entries = yield* readEntriesAt([target]);

    return entries.get(entryTargetKey(target)) ?? [];
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

const unmentionedWithImage = (
  input: Unmentioned,
  previous: StoredEntry | undefined
): JsonValue | undefined => {
  const { at, origin, platform, field } = input;

  if (
    previous?.image === undefined ||
    origin === undefined ||
    platform ||
    origin.numbered
  ) {
    return unmentionedValue(input);
  }

  if (
    previous.schemaRevision < origin.revision &&
    at.schemaRevision >= origin.revision
  ) {
    return addedValue(field, origin);
  }

  return unmentionedValue(input);
};

const savedVersionImage = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  image: JsonObject
): VersionImage => {
  const known = new Map<DefinitionId, JsonValue>();
  const unknown = new Set<DefinitionId>();

  for (const field of payloadFields(snapshot, classId)) {
    const value = image[field.id];

    if (value === undefined) {
      unknown.add(field.id);
    } else {
      known.set(field.id, value);
    }
  }

  return { known, unknown };
};

const mentionedValues = (
  entries: readonly StoredEntry[],
  at: StoredEntry
): ReadonlyMap<DefinitionId, JsonValue> => {
  const mentioned = new Map<DefinitionId, JsonValue>();
  const applied = at.kind === "delete" ? [at] : entries;
  const side = at.kind === "delete" ? "before" : "after";

  for (const entry of applied) {
    for (const [fieldId, value] of Object.entries(entry.image ?? {})) {
      mentioned.set(fieldId, value);
    }

    for (const [fieldId, change] of Object.entries(entry.fields)) {
      mentioned.set(fieldId, sideOf(change, side));
    }
  }

  return mentioned;
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

  if (at.image !== undefined && at.kind !== "delete") {
    return savedVersionImage(snapshot, at.recordClassId, at.image);
  }

  const [first] = entries;

  const startsWithCreate =
    first?.kind === "create" &&
    first.recordVersion === 1 &&
    (at.completeFromCreate ?? entries.length === at.recordVersion);

  const mentioned = mentionedValues(entries, at);

  const platform = snapshot.class(at.recordClassId)?.storage === "platform";

  for (const field of payloadFields(snapshot, at.recordClassId)) {
    let value = at.image?.[field.id];

    if (mentioned.has(field.id)) {
      value = mentioned.get(field.id);
    } else if (value === undefined) {
      // A legacy delete proves its empty fields even when v-1's image is partial.
      value = unmentionedWithImage(
        {
          at,
          created: startsWithCreate ? first : undefined,
          field,
          origin: origins.get(field.id),
          platform,
        },
        entries.at(-2)
      );
    }

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
