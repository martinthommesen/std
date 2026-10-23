import {
  arrayParameter,
  identSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
/**
 * What a mapped TMF hub's events read beyond their change entry
 * (Contracts 12.1; decision 0035), in the preparation transaction, as the
 * hub's identity:
 *
 * - **Arrays of parts.** A change of an owner's version touches an array
 *   when the operation wrote a part of it (a note added, a related party
 *   changed) that the identity may see, or changed a field an owner item
 *   renders from (the ticket's caller). Each part write belongs to the
 *   owner's first version at or after it: every part write is followed in
 *   its own transaction by the owner's aggregate save (Contracts 4.9), and
 *   change IDs are UUIDv7, ordered by the aggregate root's lock. A touched
 *   array is read whole, as TMF630 v5.0.0 Part 1 §11.6.2 pp.202-203 asks:
 *   every part of the owner at the change, each at its version then, from
 *   the change history, masked by the identity's current read rules like
 *   any delivery payload (`payloadOf`). An array whose owner reference the
 *   identity cannot read on the part class is unreadable, as in a GET.
 * - **Reference paths** (`assigned_to.individual`): the target's field as
 *   the identity may read it now, for the reference the change's image
 *   holds.
 *
 * Reference labels are not read (the event's references carry their
 * `id`), so a part renders what its own fields give.
 */
import type { DefinitionId } from "@std/definitions/ids";
import { pathOf, SYSTEM_SOURCES } from "@std/tmf/mapping";
import type {
  Attribute,
  PartsAttribute,
  SourceKey,
  SourceRecord,
} from "@std/tmf/mapping";
import { formatDateTime } from "@std/values/date-time";
import { isJsonNumber, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { parseTimestamptzText } from "@std/values/postgres-text";
import { Effect } from "effect";

import type { MappedResource } from "../http/tmf/context.ts";
import { readFieldOf, sourceKeysOf, withHistory } from "../http/tmf/sources.ts";
import type { Delivery, RenderPrepared } from "../outbox/delivery-effects.ts";
import {
  PayloadUnreadable,
  payloadOf,
  readEntries,
  readFieldOrigins,
  versionImage,
} from "../outbox/delivery-payload.ts";
import type { FieldOrigin } from "../outbox/delivery-payload.ts";
import { currentReadScope, readByIds } from "../records/read-records.ts";
import type { DecodedRecord } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { recordRelation } from "../records/relation.ts";
import { readRows } from "../records/sql-run.ts";
import { mappedResourceOfHub, sourceValuesOf } from "./tmf-events.ts";

const NOTHING: RenderPrepared = { parts: new Map(), paths: new Map() };

/** The smallest UUID: no change entry comes before it. */
const NO_CHANGE = "00000000-0000-0000-0000-000000000000";

/** What reading one delivery's arrays shares. */
interface ArrayRead {
  readonly delivery: Delivery;
  readonly scope: ReadScope;
  /** Field origins by class, read once per class. */
  readonly origins: Map<DefinitionId, ReadonlyMap<DefinitionId, FieldOrigin>>;
}

const originsOf = Effect.fnUntraced(function* originsOf(
  read: ArrayRead,
  classId: DefinitionId
) {
  const known = read.origins.get(classId);

  if (known !== undefined) {
    return known;
  }

  const origins = yield* readFieldOrigins(read.delivery.snapshot, classId);

  read.origins.set(classId, origins);

  return origins;
});

/** One part version as history holds it. */
interface PartVersion {
  readonly recordId: string;
  readonly version: number;
}

/**
 * A part at one version as the identity may see it: whether it is visible
 * and names the owner, and its readable values.
 *
 * @param read - The delivery and scope.
 * @param part - The part's version, which history holds.
 * @returns Its whole known image and its payload for the identity.
 */
const partAt = Effect.fnUntraced(function* partAt(
  read: ArrayRead,
  part: PartVersion
) {
  const { snapshot } = read.delivery;
  const entries = yield* readEntries(part.recordId, part.version);
  const entry = entries.at(-1);

  if (entry === undefined) {
    return yield* new PayloadUnreadable({
      reason: `Part ${part.recordId} has no change entry at version ${part.version}.`,
    });
  }

  const origins = yield* originsOf(read, entry.recordClassId);

  const payload = payloadOf(
    snapshot,
    read.scope.caller,
    { entries, origins, recordId: part.recordId },
    read.scope.context
  );

  if (payload instanceof PayloadUnreadable) {
    return yield* payload;
  }

  return {
    known: versionImage(snapshot, entries, origins).known,
    payload,
  };
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
 * The arrays the operation's part writes touched for this owner version:
 * those with a written part the identity may see.
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
  const { payload } = delivery;
  const touched = new Set<string>();

  const rows = yield* readRows(
    sql`SELECT DISTINCT ON ("c"."record_id") "c"."record_id"::text AS "record_id",
  "c"."record_version"::text AS "version"
FROM core."change" AS "c"
WHERE "c"."operation_id" = ${textParameter(payload.operationId, "uuid")}
  AND "c"."id" <= ${textParameter(delivery.changeId, "uuid")}
  AND "c"."id" > COALESCE((SELECT "p"."id" FROM core."change" AS "p"
    WHERE "p"."record_id" = ${textParameter(delivery.recordId, "uuid")}
      AND "p"."record_version" = ${textParameter(String(delivery.recordVersion - 1), "int8")}),
    ${textParameter(NO_CHANGE, "uuid")})
  AND "c"."record_class_id" = ANY(${arrayParameter(partClassesOf(delivery, arrays), "uuid")})
ORDER BY "c"."record_id", "c"."record_version" DESC`
  );

  for (const row of rows) {
    const recordId = row.record_id ?? "";

    const part = yield* partAt(read, {
      recordId,
      version: Number(row.version),
    });

    const array = arrayOfClass(delivery, arrays, part.payload.classId);

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

  const classes = partClassesOf(delivery, [array]);

  // Today's parts of the owner, and those deleted since the change.
  const live = yield* readRows(
    sql`SELECT ${identSql("p", "id")}::text AS "id"
FROM ${recordRelation(snapshot, owner.classId)} AS ${identSql("p")}
WHERE ${identSql("p", owner.name)} = ${textParameter(delivery.recordId, "uuid")}`
  );

  const deleted = yield* readRows(
    sql`SELECT "c"."record_id"::text AS "id"
FROM core."change" AS "c" JOIN core."change_image" AS "i" ON "i"."change_id" = "c"."id"
WHERE "c"."id" > ${textParameter(delivery.changeId, "uuid")} AND "c"."kind" = 'delete'
  AND "c"."record_class_id" = ANY(${arrayParameter(classes, "uuid")})
  AND "i"."before_image" ->> ${textParameter(owner.id, "text")} = ${textParameter(delivery.recordId, "text")}`
  );

  const ids = [...live, ...deleted].flatMap((row) =>
    row.id === undefined || row.id === null ? [] : [row.id]
  );

  // Each one's version at the change, and when it was created.
  const versions = yield* readRows(
    sql`SELECT DISTINCT ON ("c"."record_id") "c"."record_id"::text AS "id",
  "c"."record_version"::text AS "version", "c"."kind", "c"."occurred_at"::text AS "updated_at",
  (SELECT "f"."occurred_at" FROM core."change" AS "f"
    WHERE "f"."record_id" = "c"."record_id" AND "f"."record_version" = 1)::text AS "created_at"
FROM core."change" AS "c"
WHERE "c"."record_id" = ANY(${arrayParameter(ids, "uuid")})
  AND "c"."id" <= ${textParameter(delivery.changeId, "uuid")}
ORDER BY "c"."record_id", "c"."record_version" DESC`
  );

  const parts: (SourceRecord & { readonly createdAt: number })[] = [];

  for (const row of versions) {
    const id = row.id ?? "";
    const created = parseTimestamptzText(row.created_at ?? "");
    const updated = parseTimestamptzText(row.updated_at ?? "");

    const part =
      row.kind === "delete"
        ? undefined
        : yield* partAt(read, { recordId: id, version: Number(row.version) });

    if (
      part !== undefined &&
      part.payload.visible &&
      part.payload.image[owner.id] === delivery.recordId
    ) {
      const values = new Map(sourceValuesOf(snapshot, part.payload.image));

      for (const [key, time] of [
        [SYSTEM_SOURCES.createdAt, created],
        [SYSTEM_SOURCES.updatedAt, updated],
      ] as const) {
        if (time.ok) {
          values.set(key, { value: formatDateTime(time.value) });
        }
      }

      parts.push({
        classId: part.payload.classId,
        createdAt: created.ok ? created.value : 0,
        id,
        parts: new Map(),
        values,
        version: part.payload.recordVersion,
      });
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
 * and the referenced ID the version's image holds; null when the
 * identity cannot read the reference or the target's field.
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
 * reference paths, and for an update the whole arrays it touched. Other
 * hubs need nothing.
 *
 * @param delivery - The delivery.
 * @returns The arrays and paths.
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
    const read: ArrayRead = { delivery, origins: new Map(), scope };
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
