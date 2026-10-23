/**
 * What a mapped TMF hub's events read beyond their change entry
 * (Contracts 12.1; decision 0035), in the preparation transaction, as the
 * hub's identity:
 *
 * - **Arrays of parts.** An update of an owner touches an array when it
 *   changed a field an owner item renders from (the ticket's caller), or
 *   when it is the owner's aggregate save and its transaction wrote a part
 *   of the array that the identity may see (a note added, a related party
 *   changed). A touched array is read whole, as TMF630 v5.0.0 Part 1
 *   §11.6.2 pp.202-203 asks: every part of the owner at the change, each
 *   at its version then, masked by the identity's current read rules like
 *   any delivery payload (`payloadOf`). An array whose owner reference the
 *   identity cannot read on the part class is unreadable, as in a GET.
 * - **Which part versions belong to an owner version** follows from the
 *   change entries, never from clocks or ID order: every part write is
 *   finalized in its own transaction by exactly one aggregate save of its
 *   owner (Contracts 4.9), which lists the saves' part changes in
 *   `cause.aggregate.parts` and shares the transaction's `operation_id`
 *   with them and with the part writes the settling made. So a part change
 *   belongs to the owner version of the aggregate save in its operation,
 *   or of the owner's delete there (which deletes its parts without an
 *   aggregate save); a part change with neither predates aggregates (a set
 *   before helpdesk v3) and so every aggregate version.
 * - **A fixed number of statements**, whatever the number of parts: the
 *   touched parts in one, the array's members (today's parts and those
 *   deleted after the change) in two, and their versions at the change with
 *   their saved images (`core.change_image`) in one. Only a change entry the
 *   image backfill (migration 0028) has not reached yet is rebuilt alone,
 *   from its history (`readEntries`).
 * - **Reference paths** (`assigned_to.individual`): the target's field as
 *   the identity may read it now, for the reference the change's image
 *   holds; `statusChangeHistory` from the record's history up to the
 *   change (`withHistory`).
 *
 * Reference labels are not read (the event's references carry their
 * `id`), so a part renders what its own fields give.
 */
import {
  arrayParameter,
  identSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import { pathOf, SYSTEM_SOURCES } from "@std/tmf/mapping";
import type {
  Attribute,
  PartsAttribute,
  SourceKey,
  SourceRecord,
} from "@std/tmf/mapping";
import { formatDateTime } from "@std/values/date-time";
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import {
  parseJsonbText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { Effect, Schema } from "effect";

import type { MappedResource } from "../http/tmf/context.ts";
import {
  readFieldOf,
  sourceKeysOf,
  sourceValuesOf,
  withHistory,
} from "../http/tmf/sources.ts";
import type { Delivery, RenderPrepared } from "../outbox/delivery-effects.ts";
import {
  PayloadUnreadable,
  payloadOf,
  readFieldOrigins,
  readHistories,
  versionImage,
} from "../outbox/delivery-payload.ts";
import type {
  DeliveryPayload,
  FieldOrigin,
  StoredEntry,
} from "../outbox/delivery-payload.ts";
import { ChangeKindSchema } from "../records/change-entry.ts";
import { currentReadScope, readByIds } from "../records/read-records.ts";
import type { DecodedRecord } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { recordRelation } from "../records/relation.ts";
import { readRows } from "../records/sql-run.ts";
import { decodeRows } from "../sql/rows.ts";
import { mappedResourceOfHub } from "./tmf-events.ts";

const NOTHING: RenderPrepared = { parts: new Map(), paths: new Map() };

/** One part change with its saved image, as the version queries read it. */
const PartRowSchema = Schema.Struct({
  change_id: Schema.String,
  created_at: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  kind: ChangeKindSchema,
  occurred_at: Schema.String,
  record_class_id: Schema.String,
  record_id: Schema.String,
  schema_revision: Schema.FiniteFromString,
  version: Schema.FiniteFromString,
});

type PartRow = typeof PartRowSchema.Type;

const PartRows = decodeRows(PartRowSchema);

// The columns of a part change, its image (a delete's: the image before
// it, saved with it or with the version before) and its creation time.
const PART_COLUMNS = sql`"p"."id"::text AS "change_id", "p"."record_id"::text AS "record_id",
  "p"."record_class_id"::text AS "record_class_id", "p"."record_version"::text AS "version",
  "p"."kind", "p"."occurred_at"::text AS "occurred_at",
  "p"."schema_revision"::text AS "schema_revision",
  (CASE WHEN "p"."kind" = 'delete' THEN COALESCE("i"."before_image", "pi"."after_image")
    ELSE "i"."after_image" END)::text AS "image",
  (SELECT "f"."occurred_at" FROM core."change" AS "f"
    WHERE "f"."record_id" = "p"."record_id" AND "f"."record_version" = 1)::text AS "created_at"`;

const PART_IMAGES = sql`LEFT JOIN core."change_image" AS "i" ON "i"."change_id" = "p"."id"
LEFT JOIN core."change" AS "pp" ON "pp"."record_id" = "p"."record_id"
  AND "pp"."record_version" = "p"."record_version" - 1
LEFT JOIN core."change_image" AS "pi" ON "pi"."change_id" = "pp"."id"`;

/**
 * The owner versions part changes belong to: its aggregate saves, and its
 * delete, whose transaction deletes its parts with no aggregate save
 * (Contracts 4.9: a deleted owner is never finalized).
 */
const OWNER_VERSION = sql`("o"."cause" ? 'aggregate' OR "o"."kind" = 'delete')`;

/** What reading one delivery's arrays shares. */
interface ArrayRead {
  readonly delivery: Delivery;
  readonly scope: ReadScope;
}

/** A part at one version: its whole image and what the identity sees. */
interface PartAt {
  readonly row: PartRow;
  /** Field ID to canonical JSON, unmasked (the owner reference). */
  readonly known: ReadonlyMap<DefinitionId, JsonValue>;
  readonly payload: DeliveryPayload;
}

/**
 * A part change with its saved image as the entries `payloadOf` reads: the
 * image is the version's whole image (a delete's: the one it removed), so
 * the entry is read as a version of it.
 *
 * @param row - The part change.
 * @param text - Its saved image.
 * @returns The entries, or undefined when the image does not parse.
 */
const savedEntries = (
  row: PartRow,
  text: string
): readonly StoredEntry[] | undefined => {
  const saved = parseJsonbText(text);
  const occurredAt = parseTimestamptzText(row.occurred_at);

  if (!saved.ok || !isJsonObject(saved.value)) {
    return undefined;
  }

  return [
    {
      actorId: "",
      changeId: row.change_id,
      fields: {},
      image: saved.value,
      kind: row.kind === "delete" ? "update" : row.kind,
      occurredAt: occurredAt.ok ? occurredAt.value : 0,
      operationId: "",
      recordClassId: row.record_class_id,
      recordVersion: row.version,
      schemaRevision: row.schema_revision,
    },
  ];
};

/**
 * Part changes as the identity may see them: each saved image masked by
 * `payloadOf`; the entries the image backfill (migration 0028) has not
 * reached yet are rebuilt together, from one read of their histories
 * (`readHistories`) and each class's field origins, read once.
 *
 * @param read - The delivery and scope.
 * @param rows - The part changes.
 * @returns Each part at that version, in the rows' order.
 */
const partsAt = Effect.fnUntraced(function* partsAt(
  read: ArrayRead,
  rows: readonly PartRow[]
) {
  const { snapshot } = read.delivery;
  const legacy = rows.filter((row) => row.image === null);

  const histories = yield* readHistories(
    legacy.map((row) => ({ recordId: row.record_id, version: row.version }))
  );

  const origins = new Map<
    DefinitionId,
    ReadonlyMap<DefinitionId, FieldOrigin>
  >();

  for (const classId of new Set(legacy.map((row) => row.record_class_id))) {
    origins.set(classId, yield* readFieldOrigins(snapshot, classId));
  }

  const parts: PartAt[] = [];

  for (const row of rows) {
    const entries =
      row.image === null
        ? histories.get(row.record_id)
        : savedEntries(row, row.image);

    if (entries === undefined) {
      return yield* new PayloadUnreadable({
        reason: `Part ${row.record_id} at version ${row.version} (change ${row.change_id}) is not readable.`,
      });
    }

    const classOrigins = origins.get(row.record_class_id) ?? new Map();

    const payload = payloadOf(
      snapshot,
      read.scope.caller,
      { entries, origins: classOrigins, recordId: row.record_id },
      read.scope.context
    );

    if (payload instanceof PayloadUnreadable) {
      return yield* payload;
    }

    parts.push({
      known: versionImage(snapshot, entries, classOrigins).known,
      payload,
      row,
    });
  }

  return parts;
});

const partClassesOf = (
  delivery: Delivery,
  arrays: readonly PartsAttribute[]
): readonly DefinitionId[] => [
  ...new Set(
    arrays.flatMap((attribute) =>
      delivery.snapshot.subtreeIds(attribute.item.classId)
    )
  ),
];

const arrayOfClass = (
  delivery: Delivery,
  arrays: readonly PartsAttribute[],
  classId: DefinitionId
): PartsAttribute | undefined => {
  const lineage = new Set(
    delivery.snapshot.lineage(classId).map((entry) => entry.id)
  );

  return arrays.find((attribute) => lineage.has(attribute.item.classId));
};

/**
 * The arrays an aggregate save's transaction wrote a part of that the
 * identity may see: the part changes of the save's operation (those
 * `cause.aggregate.parts` lists and those the settling wrote). Any other
 * owner change wrote no part (Contracts 4.9).
 *
 * @param read - The delivery and scope.
 * @param arrays - The resource's arrays of parts.
 * @returns The arrays' names.
 */
const arraysWritten = Effect.fnUntraced(function* arraysWritten(
  read: ArrayRead,
  arrays: readonly PartsAttribute[]
) {
  const { delivery } = read;
  const touched = new Set<string>();

  const rows = yield* readRows(
    sql`SELECT ${PART_COLUMNS}
FROM core."change" AS "o"
JOIN core."change" AS "p" ON "p"."operation_id" = "o"."operation_id"
${PART_IMAGES}
WHERE "o"."id" = ${textParameter(delivery.changeId, "uuid")} AND "o"."cause" ? 'aggregate'
  AND "p"."record_class_id" = ANY(${arrayParameter(partClassesOf(delivery, arrays), "uuid")})`
  ).pipe(Effect.flatMap(PartRows));

  for (const part of yield* partsAt(read, rows)) {
    const array = arrayOfClass(delivery, arrays, part.row.record_class_id);

    if (
      array !== undefined &&
      part.payload.visible &&
      part.known.get(array.item.ownerField) === delivery.recordId
    ) {
      touched.add(array.name);
    }
  }

  return touched;
});

/**
 * A visible part as the mapping reads it, with its system dates.
 *
 * @param read - The delivery and scope.
 * @param part - The part at its version.
 * @returns The source record and its creation time.
 */
const sourcePartOf = (
  read: ArrayRead,
  part: PartAt
): SourceRecord & { readonly createdAt: number } => {
  const created = parseTimestamptzText(part.row.created_at ?? "");
  const updated = parseTimestamptzText(part.row.occurred_at);

  const values = new Map(
    sourceValuesOf(read.delivery.snapshot, part.payload.image)
  );

  for (const [key, time] of [
    [SYSTEM_SOURCES.createdAt, created],
    [SYSTEM_SOURCES.updatedAt, updated],
  ] as const) {
    if (time.ok) {
      values.set(key, { value: formatDateTime(time.value) });
    }
  }

  return {
    classId: part.payload.classId,
    createdAt: created.ok ? created.value : 0,
    id: part.row.record_id,
    parts: new Map(),
    values,
    version: part.payload.recordVersion,
  };
};

/**
 * The parts of an array at the change, each at its version then, as the
 * identity may see them, in the array's order (the item's order field
 * when readable, then creation, then ID).
 *
 * @param read - The delivery and scope.
 * @param array - The array.
 * @returns The parts, or null when the array is unreadable.
 */
const partsAtChange = Effect.fnUntraced(function* partsAtChange(
  read: ArrayRead,
  array: PartsAttribute
) {
  const { delivery, scope } = read;
  const { snapshot } = delivery;
  const { item } = array;
  const owner = snapshot.field(item.ownerField);

  if (
    owner === undefined ||
    readFieldOf(scope.view(item.classId), item.ownerField) === undefined
  ) {
    return null;
  }

  const classes = arrayParameter(partClassesOf(delivery, [array]), "uuid");
  const ownerId = textParameter(delivery.recordId, "uuid");
  const version = textParameter(String(delivery.recordVersion), "int8");

  // The members: today's parts of the owner, and those a later aggregate
  // version of it deleted.
  const live = yield* readRows(
    sql`SELECT ${identSql("p", "id")}::text AS "id"
FROM ${recordRelation(snapshot, owner.classId)} AS ${identSql("p")}
WHERE ${identSql("p", owner.name)} = ${ownerId}`
  );

  const deleted = yield* readRows(
    sql`SELECT "p"."record_id"::text AS "id"
FROM core."change" AS "o"
JOIN core."change" AS "p" ON "p"."operation_id" = "o"."operation_id"
WHERE "o"."record_id" = ${ownerId} AND "o"."record_version" > ${version}
  AND ${OWNER_VERSION} AND "p"."kind" = 'delete'
  AND "p"."record_class_id" = ANY(${classes})`
  );

  const ids = [...live, ...deleted].flatMap((row) =>
    row.id === undefined || row.id === null ? [] : [row.id]
  );

  // Each member's last change that belongs to an owner version up to the
  // change's: the aggregate save or delete in its operation, or none
  // (before aggregates).
  const versions = yield* readRows(
    sql`SELECT DISTINCT ON ("p"."record_id") ${PART_COLUMNS}
FROM core."change" AS "p"
LEFT JOIN core."change" AS "o" ON "o"."operation_id" = "p"."operation_id"
  AND "o"."record_id" = ${ownerId} AND ${OWNER_VERSION}
${PART_IMAGES}
WHERE "p"."record_id" = ANY(${arrayParameter(ids, "uuid")})
  AND ("o"."record_version" IS NULL OR "o"."record_version" <= ${version})
ORDER BY "p"."record_id", "p"."record_version" DESC`
  ).pipe(Effect.flatMap(PartRows));

  const parts: (SourceRecord & { readonly createdAt: number })[] = [];

  const kept = versions.filter((row) => row.kind !== "delete");

  for (const part of yield* partsAt(read, kept)) {
    if (
      part.payload.visible &&
      part.payload.image[owner.id] === delivery.recordId
    ) {
      parts.push(sourcePartOf(read, part));
    }
  }

  const order = item.orderField;

  const position = (part: SourceRecord): number => {
    const value =
      order === undefined ? undefined : part.values.get(order)?.value;

    return value !== undefined && isJsonNumber(value)
      ? value
      : Number.POSITIVE_INFINITY;
  };

  return parts
    .toSorted(
      (left, right) =>
        // Unordered parts (both positions infinite) fall through.
        position(left) - position(right) ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id)
    )
    .map(({ createdAt: _created, ...part }) => part);
});

/**
 * Where a path source's value is read: the target class's view, its field
 * and the referenced ID the version's image holds; null when the identity
 * cannot read the reference or the target's field.
 *
 * @param scope - The identity's scope.
 * @param delivery - The delivery.
 * @param key - A source.
 * @returns The target, or null (also for a plain field).
 */
const pathTargetOf = (scope: ReadScope, delivery: Delivery, key: SourceKey) => {
  const { image } = delivery.payload;
  const path = pathOf(key);

  const reference =
    path === undefined ? undefined : delivery.snapshot.field(path.reference);

  if (
    path === undefined ||
    reference?.type.kind !== "reference" ||
    !Object.hasOwn(image, reference.id)
  ) {
    return null;
  }

  const view = scope.view(reference.type.targetClassId);
  const field = view.byId(path.target);

  return field === undefined
    ? null
    : { field, id: image[reference.id] ?? null, view };
};

/**
 * The reference paths the resource renders from, as the identity may read
 * them on the targets the version's image names (Contracts 3.6): null when
 * the reference is empty or its target hidden; absent when the identity
 * cannot read the reference or the target's field.
 *
 * @param scope - The identity's scope.
 * @param delivery - The delivery.
 * @param attributes - The resource's attributes.
 * @returns The values by path source.
 */
const pathsOf = Effect.fnUntraced(function* pathsOf(
  scope: ReadScope,
  delivery: Delivery,
  attributes: readonly Attribute[]
) {
  const paths = new Map<SourceKey, JsonValue>();

  for (const key of sourceKeysOf(attributes)) {
    const target = pathTargetOf(scope, delivery, key);
    const id = target?.id ?? null;

    if (target !== null) {
      const found =
        id !== null && isJsonString(id)
          ? yield* readByIds(scope, target.view, [id], {
              selection: [{ field: target.field, key: target.field.name }],
              withLabels: false,
              withTargets: false,
            })
          : new Map<string, DecodedRecord>();

      const entry = isJsonString(id) ? found.get(id)?.entries[0] : undefined;

      paths.set(
        key,
        entry === undefined || entry.withheld ? null : entry.value
      );
    }
  }

  return paths;
});

const isParts = (attribute: Attribute): attribute is PartsAttribute =>
  attribute.kind === "parts";

/**
 * The arrays an update touched: a part written that the identity may see,
 * or a changed field an owner item renders from.
 *
 * @param read - The delivery and scope.
 * @param arrays - The resource's arrays of parts.
 * @returns The touched arrays.
 */
const arraysTouched = Effect.fnUntraced(function* arraysTouched(
  read: ArrayRead,
  arrays: readonly PartsAttribute[]
) {
  const written = yield* arraysWritten(read, arrays);
  const changes = new Set(Object.keys(read.delivery.payload.changes));

  return arrays.filter(
    (array) =>
      written.has(array.name) ||
      (array.ownerItems ?? []).some((owner) =>
        owner.sources.some((source) =>
          changes.has(pathOf(source)?.reference ?? source)
        )
      )
  );
});

/**
 * Reads what a mapped hub's events render beyond the change entry, as the
 * hub's identity in the preparation transaction (decision 0035): the
 * reference paths, the history-backed attributes' entries, and for an
 * update the whole arrays it touched. Other hubs need nothing.
 *
 * @param delivery - The delivery.
 * @returns The arrays, paths and history.
 */
export const prepareMappedEvents = Effect.fn("Events.prepareMappedEvents")(
  function* prepareMappedEvents(delivery: Delivery) {
    const { hub } = delivery.subscription;
    const { payload } = delivery;

    const mapped: MappedResource | undefined =
      hub === undefined || hub === null || hub.api === "TMF688"
        ? undefined
        : mappedResourceOfHub(hub);

    if (mapped === undefined || !payload.visible || payload.kind === "delete") {
      return NOTHING;
    }

    const scope = yield* currentReadScope();
    const { attributes } = mapped.resource;
    const paths = yield* pathsOf(scope, delivery, attributes);

    // The history-backed attributes' entries up to the change, as a GET
    // reads them (`withHistory`).
    const [own] = yield* withHistory(
      attributes,
      [
        {
          classId: payload.classId,
          id: payload.recordId,
          parts: new Map(),
          values: sourceValuesOf(delivery.snapshot, payload.image),
          version: payload.recordVersion,
        },
      ],
      () => true
    );

    const history = own?.history?.filter(
      (step) => step.version <= payload.recordVersion
    );

    const prepared = history === undefined ? { paths } : { history, paths };

    if (payload.kind === "create") {
      return { ...prepared, parts: new Map() } satisfies RenderPrepared;
    }

    const arrays = attributes.filter(isParts);
    const read: ArrayRead = { delivery, scope };
    const parts = new Map<string, readonly SourceRecord[]>();

    for (const array of yield* arraysTouched(read, arrays)) {
      const found = yield* partsAtChange(read, array);

      if (found !== null) {
        parts.set(array.name, found);
      }
    }

    return { ...prepared, parts } satisfies RenderPrepared;
  }
);
