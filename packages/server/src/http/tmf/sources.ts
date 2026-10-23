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
import type { DefinitionId } from "@std/definitions/ids";
import type {
  Attribute,
  SourceKey,
  SourceRecord,
  SourceValue,
} from "@std/tmf/mapping";
import { isJsonString } from "@std/values/json-value";
import { Effect } from "effect";

import { decodeCursor } from "../../records/read-cursor.ts";
import type { ReadField } from "../../records/read-field.ts";
import { compileFilterExpr, MAX_LIMIT } from "../../records/read-query.ts";
import type { SelectedValue, SortKey } from "../../records/read-query.ts";
import { readByIds, readPage } from "../../records/read-records.ts";
import type { DecodedRecord, Page } from "../../records/read-records.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";

const SYSTEM_PREFIX = "system:";

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
 * Every field key the attributes render from or write, value attributes
 * only (parts are read separately).
 *
 * @param attributes - The attributes.
 * @returns The keys.
 */
export const sourceKeysOf = (
  attributes: readonly Attribute[]
): ReadonlySet<SourceKey> =>
  new Set(
    attributes.flatMap((attribute) =>
      attribute.kind === "parts" ? [] : [...attribute.sources]
    )
  );

/**
 * The selection that reads every source the caller can read in a view.
 *
 * @param view - The view.
 * @param keys - The sources.
 * @returns The selection.
 */
export const selectionOf = (
  view: ReadView,
  keys: ReadonlySet<SourceKey>
): readonly SelectedValue[] =>
  [...keys].flatMap((key) => {
    const field = readFieldOf(view, key);

    return field === undefined ? [] : [{ field, key: field.name }];
  });

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
