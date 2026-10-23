/**
 * Reading the records of a TMF resource (Contracts 11.1) through the
 * record service's read compiler, as the caller: the same visibility,
 * masks and labels as every other read (3.4 to 3.6), so a TMF API never
 * shows more than the generic API would.
 *
 * - A record read through the mapped class's collection is read again
 *   through its own concrete class (as `/api/v1` does, decision 0025 D1),
 *   so a child class's fields reach the mapping.
 * - The parts of each array attribute are read through the part class's
 *   view, filtered on the owner reference, so only parts the caller can
 *   see appear, with only the fields the caller can read. An owner
 *   reference the caller cannot read makes the array unreadable (absent).
 * - Withheld values are left out of the `SourceRecord`, so the mapping
 *   renders neither them nor any attribute derived from them.
 */
import type { Expr } from "@std/conditions/ast";
import {
  arrayParameter,
  identSql,
  joinSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment, SqlParameter } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { pathOf, pathSource } from "@std/tmf/mapping";
import type {
  Attribute,
  HistoryStep,
  SourceKey,
  SourceRecord,
  SourceValue,
  SourceValues,
} from "@std/tmf/mapping";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { EntryRowSchema, entryOfRow } from "../../records/history-query.ts";
import type { HistoryEntry } from "../../records/history-query.ts";
import { decodeCursor } from "../../records/read-cursor.ts";
import type { ReadField } from "../../records/read-field.ts";
import { compileFilterExpr, MAX_LIMIT } from "../../records/read-query.ts";
import type { SelectedValue, SortKey } from "../../records/read-query.ts";
import { readByIds, readPage } from "../../records/read-records.ts";
import type { DecodedRecord, Page } from "../../records/read-records.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import { recordRelation } from "../../records/relation.ts";
import { readRows } from "../../records/sql-run.ts";

const SYSTEM_PREFIX = "system:";

const decodeEntryRow = Schema.decodeUnknownEffect(EntryRowSchema);

/**
 * The mapping's key of a readable field.
 *
 * @param field - The field.
 * @returns Its stable ID, or `system:<name>` for a system field.
 */
export const sourceKeyOf = (field: ReadField): SourceKey =>
  field.system === undefined ? field.id : `${SYSTEM_PREFIX}${field.system}`;

/**
 * The readable field a mapping key names in a view.
 *
 * @param view - The caller's view of a class.
 * @param key - A field's stable ID or `system:<name>`.
 * @returns The field, or undefined when the caller cannot read it there.
 */
export const readFieldOf = (
  view: ReadView,
  key: SourceKey
): ReadField | undefined =>
  key.startsWith(SYSTEM_PREFIX)
    ? view.byName(key.slice(SYSTEM_PREFIX.length))
    : view.byId(key);

/**
 * The selected value a path source names in a view: the reference field,
 * when the caller can read it, and the target's field, when the caller can
 * read it on the reference's target class (Contracts 3.6).
 *
 * @param scope - The caller's scope.
 * @param view - The view of the record's class.
 * @param key - A path source (`pathSource`).
 * @returns The selection entry, or undefined.
 */
const pathSelectionOf = (
  scope: ReadScope,
  view: ReadView,
  key: SourceKey
): SelectedValue | undefined => {
  const path = pathOf(key);
  const field = path === undefined ? undefined : view.byId(path.reference);

  if (path === undefined || field?.type.kind !== "reference") {
    return undefined;
  }

  const target = scope.view(field.type.targetClassId);
  const targetField = target.byId(path.target);

  return targetField === undefined
    ? undefined
    : {
        field,
        key: `${field.name}.${targetField.name}`,
        through: { field: targetField, view: target },
      };
};

/**
 * Whether the caller can read a source in a view: a field (or system
 * field) in its visible schema, or both hops of a path source.
 *
 * @param scope - The caller's scope.
 * @param view - The view.
 * @param key - The source.
 * @returns True when readable.
 */
export const readsSource = (
  scope: ReadScope,
  view: ReadView,
  key: SourceKey
): boolean =>
  pathOf(key) === undefined
    ? readFieldOf(view, key) !== undefined
    : pathSelectionOf(scope, view, key) !== undefined;

/**
 * Every field key the attributes render from or write, value attributes
 * and the owner items of arrays (parts are read separately), with the
 * fields only some classes have (`optionalSources`).
 *
 * @param attributes - The attributes.
 * @returns The keys.
 */
export const sourceKeysOf = (
  attributes: readonly Attribute[]
): ReadonlySet<SourceKey> =>
  new Set(
    attributes.flatMap((attribute) =>
      attribute.kind === "parts"
        ? (attribute.ownerItems ?? []).flatMap((owner) => owner.sources)
        : [...attribute.sources, ...(attribute.optionalSources ?? [])]
    )
  );

/**
 * The selection that reads every source the caller can read in a view.
 *
 * @param scope - The caller's scope (for path sources' targets).
 * @param view - The view.
 * @param keys - The sources.
 * @returns The selection.
 */
export const selectionOf = (
  scope: ReadScope,
  view: ReadView,
  keys: ReadonlySet<SourceKey>
): readonly SelectedValue[] =>
  [...keys].flatMap((key) => {
    if (pathOf(key) !== undefined) {
      const path = pathSelectionOf(scope, view, key);

      return path === undefined ? [] : [path];
    }

    const field = readFieldOf(view, key);

    return field === undefined ? [] : [{ field, key: field.name }];
  });

const sourceValueOf = (
  snapshot: ConfigSnapshot,
  fieldId: string,
  value: JsonValue
): SourceValue =>
  snapshot.field(fieldId)?.type.kind === "reference" && isJsonString(value)
    ? { reference: { id: value, label: null, targetClassId: null }, value }
    : { value };

/**
 * An image (field ID to canonical JSON, a change entry's or a stored
 * record's) as the mapping reads it, readable fields only: references
 * carry their ID, without a label or target class.
 *
 * @param snapshot - The configuration.
 * @param image - Field ID to value.
 * @param readable - The fields the identity can read on that image;
 *   absent: every field the image holds.
 * @returns The values.
 */
export const sourceValuesOf = (
  snapshot: ConfigSnapshot,
  image: JsonObject,
  readable?: ReadonlySet<string>
): SourceValues =>
  new Map(
    Object.entries(image).flatMap(([fieldId, value]) =>
      (readable === undefined || readable.has(fieldId)) && value !== undefined
        ? [[fieldId, sourceValueOf(snapshot, fieldId, value)] as const]
        : []
    )
  );

const READ_OPTIONS = { withLabels: true, withTargets: true } as const;

/**
 * A decoded record's readable values by mapping key: withheld values are
 * left out; references carry what the caller may know of their target.
 *
 * @param record - The decoded record.
 * @returns The values.
 */
const valuesOf = (record: DecodedRecord): Map<SourceKey, SourceValue> => {
  const values = new Map<SourceKey, SourceValue>();

  for (const entry of record.entries) {
    const { field, through } = entry.item;

    // A path source's value: null when the target is hidden, its field
    // unreadable there, or empty (Contracts 3.6).
    if (!entry.withheld && through !== undefined) {
      values.set(pathSource(field.id, through.field.id), {
        value: entry.value,
      });
    }

    if (!entry.withheld && through === undefined) {
      const reference =
        field.type.kind === "reference" && isJsonString(entry.value)
          ? {
              id: entry.value,
              label: entry.label,
              targetClassId: entry.targetClassId,
            }
          : undefined;

      values.set(
        sourceKeyOf(field),
        reference === undefined
          ? { value: entry.value }
          : { reference, value: entry.value }
      );
    }
  }

  return values;
};

/** What reading the records of one class (and its subtree) needs. */
export interface SourceRead {
  readonly scope: ReadScope;
  /** The attributes to read for (an item's, for parts). */
  readonly attributes: readonly Attribute[];
  /** Extra fields to read on each concrete class (local extensions). */
  readonly extraKeys: (classId: DefinitionId) => ReadonlySet<SourceKey>;
}

/**
 * Reads the records of a page again through their concrete classes, with
 * the fields the mapping needs there.
 *
 * @param read - The scope, attributes and extensions.
 * @param view - The view the records were read through.
 * @param records - The records.
 * @returns The records, each read through its concrete class.
 */
const concreteRecords = Effect.fn("Tmf.concreteRecords")(
  function* concreteRecords(
    read: SourceRead,
    view: ReadView,
    records: readonly DecodedRecord[]
  ) {
    const keys = sourceKeysOf(read.attributes);
    const byClass = new Map<DefinitionId, string[]>();

    for (const record of records) {
      if (
        record.classId !== view.classId ||
        read.extraKeys(record.classId).size > 0
      ) {
        byClass.set(record.classId, [
          ...(byClass.get(record.classId) ?? []),
          record.id,
        ]);
      }
    }

    const concrete = new Map<string, DecodedRecord>();

    for (const [classId, ids] of byClass) {
      const own = read.scope.view(classId, true);

      const found = yield* readByIds(read.scope, own, ids, {
        ...READ_OPTIONS,
        selection: selectionOf(
          read.scope,
          own,
          new Set([...keys, ...read.extraKeys(classId)])
        ),
      });

      for (const [id, record] of found) {
        concrete.set(id, record);
      }
    }

    return records.map((record) => concrete.get(record.id) ?? record);
  }
);

// Parts of the owners, as the caller may see them, by owner ID.
const partsByOwner = Effect.fn("Tmf.partsByOwner")(function* partsByOwner(
  scope: ReadScope,
  attribute: Extract<Attribute, { kind: "parts" }>,
  ownerIds: readonly string[]
) {
  const view = scope.view(attribute.item.classId);
  const owner = readFieldOf(view, attribute.item.ownerField);

  // An owner reference the caller cannot read: the array is unreadable.
  if (owner === undefined || ownerIds.length === 0) {
    return owner === undefined ? undefined : new Map<string, SourceRecord[]>();
  }

  const condition: Expr = {
    left: { path: [owner.id] },
    op: "in",
    right: ownerIds.map((value) => ({ value })),
  };

  const filter = yield* compileFilterExpr(scope, view, condition);

  // The array's order: the item mapping's order field when the caller can
  // read it, then creation (decision 0033).
  const { orderField } = attribute.item;

  const order =
    orderField === undefined ? undefined : readFieldOf(view, orderField);

  const sortKeys: SortKey[] = [
    order,
    readFieldOf(view, "system:created_at"),
  ].flatMap((field) =>
    field === undefined ? [] : [{ descending: false, field }]
  );

  const selection = selectionOf(
    scope,
    view,
    // The order field too: a write keeps positions it can see unchanged.
    new Set([
      ...sourceKeysOf(attribute.item.attributes),
      ...[owner.id, orderField].flatMap((key) =>
        key === undefined ? [] : [key]
      ),
    ])
  );

  const decoded: DecodedRecord[] = [];
  let after: string | null = null;

  do {
    const position =
      after === null ? undefined : yield* decodeCursor(sortKeys, after);

    const page: Page = yield* readPage(scope, view, {
      after: position,
      before: null,
      filters: [filter],
      form: null,
      limit: MAX_LIMIT,
      offset: 0,
      selection,
      sortKeys,
      withCount: false,
      ...READ_OPTIONS,
    });

    decoded.push(...page.records);
    after = page.nextCursor;
  } while (after !== null);

  const byOwner = new Map<string, SourceRecord[]>();

  // Parts are read through the part class's view; arrays inside an item
  // (parts of parts) are not read [deferral, decision 0033].
  for (const record of decoded) {
    const part: SourceRecord = {
      classId: record.classId,
      id: record.id,
      parts: new Map(),
      values: valuesOf(record),
      version: record.version,
    };

    const ownerId = part.values.get(owner.id)?.value;

    if (ownerId !== undefined && isJsonString(ownerId)) {
      byOwner.set(ownerId, [...(byOwner.get(ownerId) ?? []), part]);
    }
  }

  return byOwner;
});

/**
 * The records of a page as the mapping reads them: each through its
 * concrete class, with the parts of every array attribute the caller can
 * see.
 *
 * @param read - The scope, attributes and extensions.
 * @param view - The view the records were read through.
 * @param records - The records.
 * @returns The source records, in order.
 */
export const readSourceRecords = Effect.fn("Tmf.readSourceRecords")(
  function* readSourceRecords(
    read: SourceRead,
    view: ReadView,
    records: readonly DecodedRecord[]
  ) {
    const concrete = yield* concreteRecords(read, view, records);
    const ids = concrete.map((record) => record.id);

    const parts = new Map<
      string,
      ReadonlyMap<string, SourceRecord[]> | undefined
    >();

    for (const attribute of read.attributes) {
      if (attribute.kind === "parts") {
        parts.set(
          attribute.name,
          yield* partsByOwner(read.scope, attribute, ids)
        );
      }
    }

    return concrete.map((record): SourceRecord => {
      const own = new Map<string, readonly SourceRecord[]>();

      for (const [name, byOwner] of parts) {
        if (byOwner !== undefined) {
          own.set(name, byOwner.get(record.id) ?? []);
        }
      }

      return {
        classId: record.classId,
        id: record.id,
        parts: own,
        values: valuesOf(record),
        version: record.version,
      };
    });
  }
);

// One change entry as a history-backed attribute sees it: the new values
// of the readable history sources it wrote (a secret's `changed` marker
// carries no value and is left out).
const stepOf = (entry: HistoryEntry): HistoryStep => {
  const changes = new Map<SourceKey, JsonValue>();

  for (const [fieldId, change] of Object.entries(entry.fields)) {
    if (isJsonObject(change) && "after" in change) {
      changes.set(fieldId, change.after ?? null);
    }
  }

  return {
    changes,
    kind: entry.kind,
    occurredAt: formatDateTime(entry.occurredAt),
    version: entry.version,
  };
};

const ENTRY_COLUMNS = sql`c.id::text AS id, c.operation_id::text AS operation_id,
  c.record_version::text AS version_text, c.kind::text AS kind,
  c.actor_id::text AS actor_id, c.occurred_at::text AS occurred_at,
  c.schema_revision::text AS schema_revision, c.cause::text AS cause, c.fields::text AS fields`;

// The entries of a record up to its version that changed one of the
// fields, in version order.
const entriesSql = (
  record: SqlFragment | SqlParameter,
  version: number,
  fieldIds: readonly string[]
) => sql`SELECT ${ENTRY_COLUMNS}
FROM core."change" c
WHERE c.record_id = ${record}
  AND c.record_version <= ${textParameter(String(version), "int8")}
  AND jsonb_exists_any(c.fields, ${arrayParameter(fieldIds, "text")})
ORDER BY c.record_version`;

const LIVE = "r";

/**
 * A record's history rows for some fields and the fields the caller may
 * still read: with a scope, read with the live record's visibility and
 * field predicates in the same statement, so one snapshot decides both (as
 * the history endpoint's read does); without one (a delivery, whose
 * payload decided readability at its version), the entries alone.
 *
 * @param record - The record as read.
 * @param fieldIds - The history fields readable on it.
 * @param scope - The caller's scope, for a live read.
 * @returns The entry rows and the readable fields.
 */
const historyRows = Effect.fnUntraced(function* historyRows(
  record: SourceRecord,
  fieldIds: readonly string[],
  scope: ReadScope | undefined
) {
  if (scope === undefined) {
    return {
      readable: new Set(fieldIds),
      rows: yield* readRows(
        entriesSql(textParameter(record.id, "uuid"), record.version, fieldIds)
      ),
    };
  }

  const view = scope.view(record.classId, true);

  const predicates = fieldIds.map((fieldId, index) => {
    const field = view.byId(fieldId);
    const holds = field === undefined ? sql`FALSE` : view.readable(LIVE, field);

    const column = identSql(`f${index}`);

    return sql`(${view.visibility(LIVE)} AND ${holds})::text AS ${column}`;
  });

  const rows = yield* readRows(
    sql`SELECT ${joinSql(predicates, ", ")}, "h".*
FROM ${recordRelation(scope.snapshot, record.classId)} AS ${identSql(LIVE)}
LEFT JOIN LATERAL (${entriesSql(identSql(LIVE, "id"), record.version, fieldIds)}) AS "h" ON true
WHERE ${identSql(LIVE, "id")} = ${textParameter(record.id, "uuid")}
ORDER BY "h"."version_text"::bigint`
  );

  const [first] = rows;

  return {
    readable: new Set(
      fieldIds.filter((_, index) => first?.[`f${index}`] === "true")
    ),
    rows: rows.filter((row) => row.id !== null && row.id !== undefined),
  };
});

/**
 * Adds to each record the change entries its selected history-backed
 * attributes render from (`ValueAttribute.history`; TMF621's
 * `statusChangeHistory`, Contracts 11.2): the entries up to the version
 * the record was read at, so the history matches the resource returned,
 * with only the history sources the caller can read (3.7). With a scope,
 * those are the sources it could read on the record as read and can still
 * read on the live record, decided in the history's own statement, so a
 * mask that a concurrent write turned on is never bypassed. Only records
 * where the caller can read every source of the attribute are read, since
 * the attribute renders only then. The attribute renders every entry, so
 * no page bounds them (TMF621 UG v5.0.1: an embedded history).
 *
 * @param attributes - The resource's attributes.
 * @param records - The records as read.
 * @param selected - Whether `fields` selects an attribute.
 * @param scope - The caller's scope, for a live read; none for a delivery.
 * @returns The records, with their history where an attribute needs it.
 */
export const withHistory = Effect.fn("Tmf.withHistory")(function* withHistory(
  attributes: readonly Attribute[],
  records: readonly SourceRecord[],
  selected: (name: string) => boolean,
  scope?: ReadScope
) {
  const needing = attributes.flatMap((attribute) =>
    attribute.kind === "value" &&
    attribute.history !== undefined &&
    selected(attribute.name)
      ? [attribute]
      : []
  );

  if (needing.length === 0) {
    return records;
  }

  const result: SourceRecord[] = [];

  for (const record of records) {
    const fieldIds = [
      ...new Set(
        needing.flatMap((attribute) =>
          attribute.sources.every((source) => record.values.has(source))
            ? (attribute.history ?? [])
            : []
        )
      ),
    ];

    if (fieldIds.length === 0) {
      result.push(record);
    } else {
      const { readable, rows } = yield* historyRows(record, fieldIds, scope);
      const steps: HistoryStep[] = [];

      for (const row of rows) {
        const entry = yield* entryOfRow(
          yield* decodeEntryRow(row).pipe(Effect.orDie),
          readable
        );

        steps.push(stepOf(entry));
      }

      result.push({ ...record, history: steps });
    }
  }

  return result;
});
