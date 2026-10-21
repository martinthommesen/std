/**
 * The record service's read operations (Contracts 2.3, 3.4 to 3.6, 6.6):
 * list and get by ID through endpoint E, for the `Actor` in the
 * environment, inside the caller's request transaction (names resolve
 * against the snapshot of the revision `core.begin_request()` returned).
 *
 * Every row decision is made by Postgres: visibility in `WHERE`, masks in
 * the select list, sort keys and cursors over masked expressions. Nothing
 * is read and then filtered here. Every value is a bound parameter, every
 * identifier is quoted, and every statement is marked `readOnly`.
 *
 * ```sql
 * SELECT "r"."id"::text AS "id", "r"."class_id"::text AS "class_id",
 *        "r"."version"::text AS "version",
 *        CAST(<value> AS text) AS "v0", CAST(COALESCE(<mask>, false) AS text) AS "w0", ...,
 *        CAST(<label> AS text) AS "l0", CAST(<sort key> AS text) AS "k0"
 *   FROM <relation(E)> AS "r"
 *   LEFT JOIN <relation(T)> AS "f1" ON "f1"."id" = <masked ref> AND (<T visibility>)  -- filter hops
 *   LEFT JOIN <relation(T)> AS "s0" ON "s0"."id" = <masked ref> AND (<T visibility>)  -- selected paths, labels
 *  WHERE "r"."class_id" = ANY($subtree) AND (<visibility>) AND (<filter>) AND (<cursor>)
 *  ORDER BY <keys>, "r"."id" ASC
 *  LIMIT <limit + 1>
 * ```
 */
import { knowsTable } from "@std/access/rules";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownTable } from "@std/api/errors/unknown-table";
import {
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { Clock, Effect, Option } from "effect";

import { Actor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import {
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  keyExpression,
  orderBy,
} from "./read-cursor.ts";
import type { CompiledKey } from "./read-cursor.ts";
import type { ReadField } from "./read-field.ts";
import {
  BASE_ALIAS,
  compileFilter,
  defaultSelection,
  parseFields,
  parseFlag,
  parseLimit,
  parseSort,
} from "./read-query.ts";
import type { SelectedValue } from "./read-query.ts";
import { makeReadScope } from "./read-view.ts";
import type { ReadScope, ReadView } from "./read-view.ts";
import { encodeTextValue, recordJson } from "./record-json.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";
import type { TextRow } from "./sql-run.ts";

/** `GET /api/v1/tables/{table}/records`. */
export interface ListRequest {
  readonly table: string;
  readonly filter?: string;
  readonly sort?: string;
  readonly fields?: string;
  readonly cursor?: string;
  readonly limit?: string;
  readonly count?: string;
  readonly labels?: string;
}

/** `GET /api/v1/tables/{table}/records/{id}`. */
export interface GetRequest {
  readonly table: string;
  readonly id: string;
  readonly fields?: string;
  readonly labels?: string;
}

const ID = identSql(BASE_ALIAS, "id");

/**
 * The caller's read scope at the transaction's revision.
 *
 * @returns The snapshot, the actor and the scope.
 */
export const currentReadScope = Effect.fn("Records.currentReadScope")(
  function* currentReadScope() {
    const actor: ActingUser = yield* Actor;
    const catalog = yield* Catalog;
    const snapshot = yield* catalog.current;
    const settings = yield* InstanceSettings;
    const now = yield* Clock.currentTimeMillis;

    return makeReadScope(snapshot, actor, {
      me: actor.userId,
      now,
      timeZone: settings.timeZone,
    });
  }
);

/**
 * Resolves an endpoint's table name for a caller (Contracts 3.4): a table
 * that does not exist and one with no allow for any of the caller's roles
 * give the same `UnknownTable`.
 *
 * @param scope - The caller's scope.
 * @param table - The qualified table name from the path.
 * @returns The class ID.
 */
export const resolveTable = Effect.fn("Records.resolveTable")(
  function* resolveTable(scope: ReadScope, table: string) {
    const found = scope.snapshot.classByName(table);

    if (
      found === undefined ||
      !knowsTable(scope.snapshot, scope.caller, found.id)
    ) {
      return yield* new UnknownTable({ table });
    }

    return found.id;
  }
);

const displayFieldOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): DefinitionId | undefined =>
  snapshot
    .lineage(classId)
    .toReversed()
    .find((level) => level.displayFieldId !== null)?.displayFieldId ??
  undefined;

/** How one selected value or label is read from a row. */
interface Column {
  readonly key: string;
  readonly field: ReadField;
  /** The output column, `v<n>`. */
  readonly value: string;
  /** The readability flag column, `w<n>`; null for always-readable fields. */
  readonly flag: string | null;
}

interface Label {
  readonly key: string;
  readonly column: string;
  readonly flag: string | null;
}

/** The select list, joins and row decoder of one read. */
interface Projection {
  readonly columns: readonly SqlFragment[];
  readonly joins: readonly SqlFragment[];
  readonly decode: (row: TextRow) => JsonObject;
}

const asText = (expression: SqlFragment, alias: string): SqlFragment =>
  sql`CAST(${expression} AS text) AS ${identSql(alias)}`;

const flagOf = (
  view: ReadView,
  field: ReadField,
  alias: string
): SqlFragment | undefined =>
  view.isAlways(field)
    ? undefined
    : sql`COALESCE(${view.readable(alias, field)}, false)`;

const isTrue = (row: TextRow, flag: string | null): boolean =>
  flag === null || row[flag] === "true";

/** The state of one projection while it is built. */
interface ProjectionBuilder {
  readonly scope: ReadScope;
  readonly view: ReadView;
  readonly columns: SqlFragment[];
  readonly joins: SqlFragment[];
  readonly joined: Map<string, string>;
}

/**
 * The alias of a reference's target, joined once per statement: the
 * reference's own mask in the join condition, then the target's
 * visibility (Contracts 3.6).
 *
 * @param builder - The projection being built.
 * @param reference - A reference field of the record.
 * @returns The target's alias.
 */
const joinTarget = (
  builder: ProjectionBuilder,
  reference: ReadField
): string => {
  const existing = builder.joined.get(reference.id);

  if (existing !== undefined) {
    return existing;
  }

  if (reference.type.kind !== "reference") {
    throw new RangeError("Only references are joined.");
  }

  const targetId = reference.type.targetClassId;
  const alias = `s${builder.joined.size}`;
  const target = builder.scope.view(targetId);

  builder.joins.push(
    sql`LEFT JOIN ${recordRelation(builder.scope.snapshot, targetId)} AS ${identSql(alias)} ON ${identSql(alias, "id")} = ${builder.view.value(BASE_ALIAS, reference)} AND ${target.visibility(alias)}`
  );
  builder.joined.set(reference.id, alias);

  return alias;
};

/**
 * The label column of a selected reference: the target's display field,
 * masked by the target's rules, over the joined target.
 *
 * @param builder - The projection being built.
 * @param reference - The reference field.
 * @param column - The column alias.
 * @returns Whether the target has a display field the caller can read.
 */
const addLabel = (
  builder: ProjectionBuilder,
  reference: ReadField,
  column: string
): boolean => {
  if (reference.type.kind !== "reference") {
    return false;
  }

  const targetId = reference.type.targetClassId;
  const target = builder.scope.view(targetId);
  const displayId = displayFieldOf(builder.scope.snapshot, targetId);
  const display = displayId === undefined ? undefined : target.byId(displayId);

  if (display === undefined) {
    return false;
  }

  const alias = joinTarget(builder, reference);
  builder.columns.push(asText(target.value(alias, display), column));

  return true;
};

const decodeRow =
  (
    scope: ReadScope,
    values: readonly Column[],
    labels: readonly Label[] | null
  ) =>
  (row: TextRow): JsonObject => {
    const delivered: Record<string, JsonValue> = {};
    const withheld: string[] = [];

    for (const column of values) {
      if (isTrue(row, column.flag)) {
        delivered[column.key] = encodeTextValue(
          column.field.type,
          row[column.value] ?? null
        );
      } else {
        withheld.push(column.key);
      }
    }

    const labelValues: Record<string, string> = {};

    for (const label of labels ?? []) {
      const text = row[label.column];

      if (isTrue(row, label.flag) && text !== null && text !== undefined) {
        labelValues[label.key] = text;
      }
    }

    return recordJson({
      className: scope.snapshot.qualifiedNameOf(row.class_id ?? "") ?? "",
      id: row.id ?? "",
      labels: labels === null ? null : labelValues,
      values: delivered,
      version: Number(row.version),
      withheld,
    });
  };

/**
 * Builds the projection of selected values and labels (Contracts 3.6,
 * 6.6): bare columns for always-readable fields, masked expressions and a
 * flag for conditional ones, one hop through joined targets for paths, and
 * the display field of each selected reference's target for labels.
 *
 * @param scope - The caller's scope.
 * @param view - The record's view.
 * @param selection - The selected values.
 * @param withLabels - Whether labels were requested.
 * @returns The select list, the joins and the row decoder.
 */
const project = (
  scope: ReadScope,
  view: ReadView,
  selection: readonly SelectedValue[],
  withLabels: boolean
): Projection => {
  const builder: ProjectionBuilder = {
    columns: [
      sql`${ID}::text AS "id"`,
      sql`${identSql(BASE_ALIAS, "class_id")}::text AS "class_id"`,
      sql`${identSql(BASE_ALIAS, "version")}::text AS "version"`,
    ],
    joined: new Map(),
    joins: [],
    scope,
    view,
  };

  const values: Column[] = [];
  const labels: Label[] = [];

  for (const [index, item] of selection.entries()) {
    const value = `v${index}`;
    const flag = flagOf(view, item.field, BASE_ALIAS);
    const flagColumn = flag === undefined ? null : `w${index}`;

    builder.columns.push(
      item.through === undefined
        ? asText(view.output(BASE_ALIAS, item.field), value)
        : asText(
            item.through.view.output(
              joinTarget(builder, item.field),
              item.through.field
            ),
            value
          )
    );

    if (flag !== undefined && flagColumn !== null) {
      builder.columns.push(asText(flag, flagColumn));
    }

    values.push({
      field: item.through?.field ?? item.field,
      flag: flagColumn,
      key: item.key,
      value,
    });

    const labelColumn = `l${index}`;

    if (
      withLabels &&
      item.through === undefined &&
      addLabel(builder, item.field, labelColumn)
    ) {
      labels.push({ column: labelColumn, flag: flagColumn, key: item.key });
    }
  }

  return {
    columns: builder.columns,
    decode: decodeRow(scope, values, withLabels ? labels : null),
    joins: builder.joins,
  };
};

const whereAll = (conditions: readonly SqlFragment[]): SqlFragment =>
  joinSql(conditions, " AND ");

const optionalJoins = (joins: readonly SqlFragment[]): SqlFragment =>
  joins.length === 0 ? rawSql("") : sql` ${joinSql(joins, " ")}`;

/**
 * Lists records through endpoint E (Contracts 3.5, 6.6).
 *
 * @param request - Table and query parameters.
 * @returns `{ schemaRevision, records, nextCursor, count? }`.
 */
export const listRecords = Effect.fn("Records.list")(function* listRecords(
  request: ListRequest
) {
  const scope = yield* currentReadScope();
  const { revision } = yield* RequestRevision;
  const classId = yield* resolveTable(scope, request.table);
  const view = scope.view(classId);

  const filter = Option.getOrUndefined(
    yield* compileFilter(scope, view, request.filter)
  );

  const sortKeys = yield* parseSort(view, request.sort);

  const selection = Option.getOrElse(
    yield* parseFields(scope, view, request.fields),
    () => defaultSelection(view)
  );

  const limit = yield* parseLimit(request.limit);
  const withCount = yield* parseFlag("count", request.count);
  const withLabels = yield* parseFlag("labels", request.labels);

  const keys: CompiledKey[] = sortKeys.map((key) => ({
    expression: keyExpression(
      key.field.type,
      view.value(BASE_ALIAS, key.field)
    ),
    key,
  }));

  const position =
    request.cursor === undefined
      ? undefined
      : yield* decodeCursor(sortKeys, request.cursor);

  const relation = recordRelation(scope.snapshot, classId);
  const filterJoins = filter === undefined ? [] : [filter.joins];

  const conditions = [
    view.visibility(BASE_ALIAS),
    ...(filter === undefined ? [] : [filter.predicate]),
  ];

  const projection = project(scope, view, selection, withLabels);

  const page = yield* readRows(
    sql`SELECT ${joinSql(
      [
        ...projection.columns,
        ...keys.map((key, index) => asText(key.expression, `k${index}`)),
      ],
      ", "
    )}
FROM ${relation} AS ${identSql(BASE_ALIAS)}${optionalJoins([...filterJoins, ...projection.joins])}
WHERE ${whereAll(
      position === undefined
        ? conditions
        : [...conditions, cursorPredicate(keys, position, ID)]
    )}
ORDER BY ${orderBy(keys, ID)}
LIMIT ${textParameter(String(limit + 1), "int8")}`
  );

  const rows = page.slice(0, limit);
  const last = rows.at(-1);

  const nextCursor =
    page.length > limit && last !== undefined
      ? encodeCursor(sortKeys, {
          id: last.id ?? "",
          values: keys.map((_, index) => last[`k${index}`] ?? null),
        })
      : null;

  const body = {
    nextCursor,
    records: rows.map(projection.decode),
    schemaRevision: revision,
  } satisfies JsonObject;

  if (withCount) {
    const [counted] = yield* readRows(
      sql`SELECT count(*)::text AS "count"
FROM ${relation} AS ${identSql(BASE_ALIAS)}${optionalJoins(filterJoins)}
WHERE ${whereAll(conditions)}`
    );

    return {
      ...body,
      count: Number(counted?.count ?? "0"),
    } satisfies JsonObject;
  }

  return body;
});

/**
 * Reads one record through endpoint E (Contracts 2.3, 3.5): the record's
 * concrete class is resolved first, then every field of that class the
 * caller can read is returned, child-only fields included. A record
 * outside E's subtree or the caller's visibility, and an ID that does not
 * exist or is not a UUID, give the same `NotFound`.
 *
 * @param request - Table, ID, selection and labels.
 * @returns `{ schemaRevision, record }`.
 */
export const getRecord = Effect.fn("Records.get")(function* getRecord(
  request: GetRequest
) {
  const scope = yield* currentReadScope();
  const { revision } = yield* RequestRevision;
  const classId = yield* resolveTable(scope, request.table);
  const endpoint = scope.view(classId);
  const explicit = yield* parseFields(scope, endpoint, request.fields);
  const withLabels = yield* parseFlag("labels", request.labels);
  const parsedId = parseUuid(request.id.toLowerCase());

  if (!parsedId.ok) {
    return yield* new NotFound();
  }

  const id = textParameter(parsedId.value, "uuid");

  const [found] = yield* readRows(
    sql`SELECT ${identSql(BASE_ALIAS, "class_id")}::text AS "class_id"
FROM ${recordRelation(scope.snapshot, classId)} AS ${identSql(BASE_ALIAS)}
WHERE ${ID} = ${id} AND ${endpoint.visibility(BASE_ALIAS)}`
  );

  const concrete = found?.class_id;

  if (concrete === undefined || concrete === null) {
    return yield* new NotFound();
  }

  const view = scope.view(concrete, true);

  const projection = project(
    scope,
    view,
    Option.getOrElse(explicit, () => defaultSelection(view)),
    withLabels
  );

  const [row] = yield* readRows(
    sql`SELECT ${joinSql(projection.columns, ", ")}
FROM ${recordRelation(scope.snapshot, concrete)} AS ${identSql(BASE_ALIAS)}${optionalJoins(projection.joins)}
WHERE ${ID} = ${id} AND ${view.visibility(BASE_ALIAS)}`
  );

  if (row === undefined) {
    return yield* new NotFound();
  }

  return {
    record: projection.decode(row),
    schemaRevision: revision,
  } satisfies JsonObject;
});
