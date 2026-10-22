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
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownField } from "@std/api/errors/unknown-field";
import { UnknownTable } from "@std/api/errors/unknown-table";
import type { CompiledCondition } from "@std/conditions/sql";
import {
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { allowedRecordsOf } from "@std/definitions/allowed-records";
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
import type { CompiledKey, CursorPosition } from "./read-cursor.ts";
import type { ReadField } from "./read-field.ts";
import {
  BASE_ALIAS,
  compileAllowedRecords,
  compileFilter,
  defaultSelection,
  parseFields,
  parseFlag,
  parseLimit,
  parseSort,
} from "./read-query.ts";
import type { SelectedValue, SortKey } from "./read-query.ts";
import { withBranchTuning } from "./read-tuning.ts";
import { makeReadScope } from "./read-view.ts";
import type { ReadScope, ReadView } from "./read-view.ts";
import { isNameable } from "./record-access.ts";
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
  /**
   * `<table>/<field>`: the reference field a picker fills; its
   * allowed-records condition is ANDed to the filter (decision 0020).
   */
  readonly allowedFor?: string;
  /**
   * `plain` forces the plain form (tests compare it with the branch form);
   * by default a visibility with several top-level ORs uses the branch form.
   */
  readonly form?: "plain" | "auto";
}

/**
 * The body of a list (Contracts 6.6). A type alias, not an interface, so
 * it stays a JSON object for `stringifyJson`.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- interfaces are not assignable to JsonObject's index signature
export type ListResult = {
  readonly schemaRevision: number;
  readonly records: readonly JsonObject[];
  readonly nextCursor: string | null;
  readonly count?: number;
};

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
  readonly item: SelectedValue;
  readonly field: ReadField;
  /** The output column, `v<n>`. */
  readonly value: string;
  /** The readability flag column, `w<n>`; null for always-readable fields. */
  readonly flag: string | null;
  /**
   * For a path: the column, `p<n>`, telling whether the target is there,
   * visible and its field readable. Otherwise the value is null whatever
   * its type, never `{"set": false}` (Contracts 6.6).
   */
  readonly present: string | null;
  /** The label column, `l<n>`, when the label is read. */
  readonly label: string | null;
  /** The target's class column, `t<n>`, when targets are read. */
  readonly target: string | null;
}

/** One selected value of a read record. */
export interface DecodedEntry {
  readonly item: SelectedValue;
  /** Whether access rules withheld the value on this record. */
  readonly withheld: boolean;
  /** The value (null for a withheld one). */
  readonly value: JsonValue;
  /**
   * The reference's label when labels were read and it may be shown (3.6);
   * otherwise null.
   */
  readonly label: string | null;
  /**
   * For a reference (not a path), when targets were read: the concrete
   * class of its target when the target is visible to the caller; null
   * otherwise (empty, hidden, withheld, or targets not read).
   */
  readonly targetClassId: DefinitionId | null;
}

/** One record as a read decoded it, before it is written as JSON. */
export interface DecodedRecord {
  readonly id: string;
  /** The concrete class. */
  readonly classId: DefinitionId;
  readonly version: number;
  /** The selected values, in selection order. */
  readonly entries: readonly DecodedEntry[];
}

/** The select list, joins and row decoder of one read. */
interface Projection {
  readonly columns: readonly SqlFragment[];
  /** The output column names, in order. */
  readonly names: readonly string[];
  readonly joins: readonly SqlFragment[];
  readonly decode: (row: TextRow) => DecodedRecord;
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

const addColumn = (
  builder: ProjectionBuilder,
  expression: SqlFragment,
  name: string
): void => {
  builder.columns.push(asText(expression, name));
  builder.names.push(name);
};

const isTrue = (row: TextRow, flag: string | null): boolean =>
  flag === null || row[flag] === "true";

/** The state of one projection while it is built. */
interface ProjectionBuilder {
  readonly scope: ReadScope;
  readonly view: ReadView;
  readonly columns: SqlFragment[];
  readonly names: string[];
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

  // A password or secret never labels a record, even if a definition set
  // made it a display field: its stored value is never returned (6.5).
  const writeOnly =
    display?.type.kind === "password" || display?.type.kind === "secret";

  if (display === undefined || writeOnly) {
    return false;
  }

  const alias = joinTarget(builder, reference);
  addColumn(builder, target.value(alias, display), column);

  return true;
};

const decodeEntry = (row: TextRow, column: Column): DecodedEntry => {
  const readable = isTrue(row, column.flag);
  const { item } = column;

  if (!readable) {
    return {
      item,
      label: null,
      targetClassId: null,
      value: null,
      withheld: true,
    };
  }

  const value =
    column.present !== null && row[column.present] !== "true"
      ? null
      : encodeTextValue(column.field.type, row[column.value] ?? null);

  const label = column.label === null ? null : (row[column.label] ?? null);
  const target = column.target === null ? null : (row[column.target] ?? null);

  return { item, label, targetClassId: target, value, withheld: false };
};

const decodeRow =
  (values: readonly Column[]) =>
  (row: TextRow): DecodedRecord => ({
    classId: row.class_id ?? "",
    entries: values.map((column) => decodeEntry(row, column)),
    id: row.id ?? "",
    version: Number(row.version),
  });

/**
 * A decoded record as `/api/v1` writes it (Contracts 6.6).
 *
 * @param scope - The caller's scope.
 * @param decoded - The record.
 * @param withLabels - Whether labels were requested (`labels` is then
 *   present, possibly empty).
 * @returns The record JSON.
 */
const v1RecordJson = (
  scope: ReadScope,
  decoded: DecodedRecord,
  withLabels: boolean
): JsonObject => {
  const delivered: Record<string, JsonValue> = {};
  const withheld: string[] = [];
  const labelValues: Record<string, string> = {};

  for (const entry of decoded.entries) {
    const { key } = entry.item;

    if (entry.withheld) {
      withheld.push(key);
    } else {
      delivered[key] = entry.value;
    }

    if (entry.label !== null) {
      labelValues[key] = entry.label;
    }
  }

  return recordJson({
    className: scope.snapshot.qualifiedNameOf(decoded.classId) ?? "",
    id: decoded.id,
    labels: withLabels ? labelValues : null,
    values: delivered,
    version: decoded.version,
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
 * @param withTargets - Whether each selected reference's target class is
 *   read (visible targets only, through the same guarded join).
 * @returns The select list, the joins and the row decoder.
 */
const project = (
  scope: ReadScope,
  view: ReadView,
  selection: readonly SelectedValue[],
  withLabels: boolean,
  withTargets = false
): Projection => {
  const builder: ProjectionBuilder = {
    columns: [
      sql`${ID}::text AS "id"`,
      sql`${identSql(BASE_ALIAS, "class_id")}::text AS "class_id"`,
      sql`${identSql(BASE_ALIAS, "version")}::text AS "version"`,
    ],
    joined: new Map(),
    joins: [],
    names: ["id", "class_id", "version"],
    scope,
    view,
  };

  const values: Column[] = [];

  for (const [index, item] of selection.entries()) {
    const value = `v${index}`;
    const flag = flagOf(view, item.field, BASE_ALIAS);
    const flagColumn = flag === undefined ? null : `w${index}`;

    const { through } = item;
    const present = through === undefined ? null : `p${index}`;

    if (through === undefined || present === null) {
      addColumn(builder, view.output(BASE_ALIAS, item.field), value);
    } else {
      const alias = joinTarget(builder, item.field);
      const target = through.field;

      addColumn(builder, through.view.output(alias, target), value);
      addColumn(
        builder,
        sql`COALESCE(${identSql(alias, "id")} IS NOT NULL AND ${through.view.readable(alias, target)}, false)`,
        present
      );
    }

    if (flag !== undefined && flagColumn !== null) {
      addColumn(builder, flag, flagColumn);
    }

    const labelColumn = `l${index}`;

    const labelled =
      withLabels &&
      item.through === undefined &&
      addLabel(builder, item.field, labelColumn);

    const targetColumn = `t${index}`;

    const targeted =
      withTargets &&
      item.through === undefined &&
      item.field.type.kind === "reference";

    if (targeted) {
      const alias = joinTarget(builder, item.field);

      addColumn(builder, identSql(alias, "class_id"), targetColumn);
    }

    values.push({
      field: item.through?.field ?? item.field,
      flag: flagColumn,
      item,
      label: labelled ? labelColumn : null,
      present,
      target: targeted ? targetColumn : null,
      value,
    });
  }

  return {
    columns: builder.columns,
    decode: decodeRow(values),
    joins: builder.joins,
    names: builder.names,
  };
};

const whereAll = (conditions: readonly SqlFragment[]): SqlFragment =>
  joinSql(conditions, " AND ");

const optionalJoins = (joins: readonly SqlFragment[]): SqlFragment =>
  joins.length === 0 ? rawSql("") : sql` ${joinSql(joins, " ")}`;

/** What a page statement is built from. */
interface PageParts {
  readonly relation: SqlFragment;
  readonly projection: Projection;
  readonly keys: readonly CompiledKey[];
  readonly joins: readonly SqlFragment[];
  /** Visibility, filter and cursor: the plain form's `WHERE`. */
  readonly conditions: readonly SqlFragment[];
  /** `class_id IN subtree(E)`. */
  readonly membership: SqlFragment;
  /** Visibility split at its top-level ORs; fewer than two: plain form. */
  readonly branches: readonly SqlFragment[];
  readonly limit: number;
  /** Rows to skip (offset paging, Contracts 10.3); 0 for cursor pages. */
  readonly offset: number;
  /** Whether the order is reversed (a `before` page; keys are flipped). */
  readonly reversed: boolean;
}

// `OFFSET` of an offset page; nothing for a cursor page.
const offsetOf = (parts: PageParts): SqlFragment =>
  parts.offset === 0
    ? rawSql("")
    : sql` OFFSET ${textParameter(String(parts.offset), "int8")}`;

const orderColumn = (index: number): SqlFragment =>
  identSql(["o", String(index)].join(""));

const selectList = (parts: PageParts): SqlFragment =>
  joinSql(
    [
      ...parts.projection.columns,
      ...parts.keys.map((key, index) => asText(key.expression, `k${index}`)),
    ],
    ", "
  );

/**
 * The page statement, plain form: one `SELECT` with the whole visibility
 * predicate in `WHERE`.
 *
 * @param parts - The page's parts.
 * @returns The statement.
 */
const plainPage = (parts: PageParts): SqlFragment =>
  sql`SELECT ${selectList(parts)}
FROM ${parts.relation} AS ${identSql(BASE_ALIAS)}${optionalJoins(parts.joins)}
WHERE ${whereAll(parts.conditions)}
ORDER BY ${orderBy(parts.keys, ID, parts.reversed)}
LIMIT ${textParameter(String(parts.limit), "int8")}${offsetOf(parts)}`;

/**
 * The page statement, branch form (storage benchmark, decision 0008): the
 * visibility predicate's top-level ORs become `UNION ALL` branches, each
 * with the full filter, cursor, `ORDER BY` and `LIMIT`, made disjoint by
 * `AND NOT COALESCE(<earlier branches>, false)`; the outer query merges
 * them with the same order and limit. Each branch can use an index for its
 * own rule. The result equals the plain form's, row for row.
 *
 * @param parts - The page's parts.
 * @returns The statement.
 */
const branchedPage = (parts: PageParts): SqlFragment => {
  const filterAndCursor = parts.conditions.slice(1);

  const branches = parts.branches.map((branch, index) => {
    const earlier = parts.branches.slice(0, index);

    const disjoint =
      earlier.length === 0
        ? []
        : [sql`NOT COALESCE((${joinSql(earlier, " OR ")}), false)`];

    const ordering = joinSql(
      [
        selectList(parts),
        ...parts.keys.map(
          (key, at) => sql`${key.expression} AS ${orderColumn(at)}`
        ),
        sql`${ID} AS "oid"`,
      ],
      ", "
    );

    return sql`(SELECT ${ordering}
FROM ${parts.relation} AS ${identSql(BASE_ALIAS)}${optionalJoins(parts.joins)}
WHERE ${whereAll([parts.membership, branch, ...disjoint, ...filterAndCursor])}
ORDER BY ${orderBy(parts.keys, ID, parts.reversed)}
LIMIT ${textParameter(String(parts.limit + parts.offset), "int8")})`;
  });

  const outer = "u";

  const names = [
    ...parts.projection.names,
    ...parts.keys.map((_, index) => `k${index}`),
  ];

  const merged: CompiledKey[] = parts.keys.map((key, index) => ({
    expression: identSql(outer, ["o", String(index)].join("")),
    key: key.key,
  }));

  return sql`SELECT ${joinSql(
    names.map((name) => identSql(outer, name)),
    ", "
  )}
FROM (${joinSql(branches, " UNION ALL ")}) AS ${identSql(outer)}
ORDER BY ${orderBy(merged, identSql(outer, "oid"), parts.reversed)}
LIMIT ${textParameter(String(parts.limit), "int8")}${offsetOf(parts)}`;
};

const allowedForProblem = (message: string) =>
  new InvalidRequest({ message, parameter: "allowedFor" });

const ALLOWED_FOR_USAGE =
  "allowedFor is <table>/<field>: a reference field whose target is this table or one of its ancestors.";

/**
 * The `allowedFor` parameter of a list (decision 0020): the reference
 * field a picker fills, as `<table>/<field>`. Its allowed-records
 * condition, compiled in the caller's view over the endpoint's records, is
 * ANDed to the request's filter; the response never shows the condition.
 *
 * - The table resolves like an endpoint (`UnknownTable` when the caller
 *   cannot name it) and the field like a write body's name (readable or
 *   writable there, else `UnknownField`), so nothing is revealed about a
 *   table or field the caller cannot name.
 * - The field must be a reference whose target is the endpoint's class or
 *   one of its ancestors (a picker may narrow to a descendant); otherwise,
 *   or when the text is not `<table>/<field>`, `InvalidRequest`.
 * - A field without a condition adds nothing.
 *
 * @param scope - The caller's scope.
 * @param endpointClassId - The listed class.
 * @param text - The parameter, if given.
 * @returns The compiled condition, or none.
 */
const compileAllowedFor = Effect.fn("Records.allowedFor")(
  function* compileAllowedFor(
    scope: ReadScope,
    endpointClassId: DefinitionId,
    text: string | undefined
  ) {
    if (text === undefined) {
      return Option.none<CompiledCondition>();
    }

    const slash = text.indexOf("/");
    const tableName = text.slice(0, slash);
    const fieldName = text.slice(slash + 1);

    if (slash <= 0 || fieldName === "" || fieldName.includes("/")) {
      return yield* allowedForProblem(ALLOWED_FOR_USAGE);
    }

    const sourceClassId = yield* resolveTable(scope, tableName);
    const field = scope.snapshot.fieldByName(sourceClassId, fieldName);

    const nameable =
      field !== undefined &&
      (isNameable(scope, sourceClassId, "create", field.id) ||
        isNameable(scope, sourceClassId, "update", field.id));

    if (field === undefined || !nameable) {
      return yield* new UnknownField({ field: fieldName });
    }

    const target =
      field.type.kind === "reference" ? field.type.targetClassId : undefined;

    const targets = scope.snapshot
      .lineage(endpointClassId)
      .some((level) => level.id === target);

    if (!targets) {
      return yield* allowedForProblem(ALLOWED_FOR_USAGE);
    }

    const condition = allowedRecordsOf(field.type);

    return condition === null
      ? Option.none<CompiledCondition>()
      : Option.some(
          compileAllowedRecords(scope, endpointClassId, condition, BASE_ALIAS)
        );
  }
);

/**
 * What one page of a list reads. `/api/v1` and `/api/v2` parse their own
 * parameters into it; everything below is shared, so both versions return
 * the same rows in the same order under the same masks (Contracts 10).
 */
export interface PageSpec {
  /** Filters ANDed to the visibility (filter text, TMF filters, pickers). */
  readonly filters: readonly CompiledCondition[];
  readonly sortKeys: readonly SortKey[];
  readonly selection: readonly SelectedValue[];
  /** 1 to {@link MAX_LIMIT}. */
  readonly limit: number;
  /** Rows to skip (0 for none); never together with a cursor. */
  readonly offset: number;
  /** A keyset position: the page after it, or the page just before it. */
  readonly cursor:
    | {
        readonly position: CursorPosition;
        readonly direction: "after" | "before";
      }
    | undefined;
  readonly withCount: boolean;
  readonly withLabels: boolean;
  /** Whether references carry their visible target's class (v2 EntityRefs). */
  readonly withTargets: boolean;
  /** `plain` forces the plain form (see {@link ListRequest}). */
  readonly form: "plain" | "auto" | undefined;
}

/** One page as read. */
export interface Page {
  readonly records: readonly DecodedRecord[];
  /** The cursor after the page's last record when more follow it. */
  readonly nextCursor: string | null;
  /** Whether more records follow the page. */
  readonly hasMore: boolean;
  /** The count of the page's `FROM` and `WHERE`, when asked for. */
  readonly count?: number;
}

const flip = (key: SortKey): SortKey => ({
  descending: !key.descending,
  field: key.field,
});

/**
 * Reads one page through endpoint E (Contracts 3.5): visibility, the
 * filters and the cursor in `WHERE`, masked sort keys with `id` last, and
 * the count with the same `FROM` and `WHERE` when asked for. A `before`
 * page reads the reversed order and returns its rows in the normal order.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param spec - What to read.
 * @returns The page.
 */
export const readPage = Effect.fn("Records.readPage")(function* readPage(
  scope: ReadScope,
  view: ReadView,
  spec: PageSpec
) {
  const reversed = spec.cursor?.direction === "before";
  const ordered = reversed ? spec.sortKeys.map(flip) : spec.sortKeys;

  const keys: CompiledKey[] = ordered.map((key) => ({
    expression: keyExpression(
      key.field.type,
      view.value(BASE_ALIAS, key.field)
    ),
    key,
  }));

  const relation = recordRelation(scope.snapshot, view.classId);
  const filterJoins = spec.filters.map((compiled) => compiled.joins);

  const conditions = [
    view.visibility(BASE_ALIAS),
    ...spec.filters.map((compiled) => compiled.predicate),
  ];

  const projection = project(
    scope,
    view,
    spec.selection,
    spec.withLabels,
    spec.withTargets
  );

  const parts: PageParts = {
    branches: spec.form === "plain" ? [] : view.visibilityBranches(BASE_ALIAS),
    conditions:
      spec.cursor === undefined
        ? conditions
        : [
            ...conditions,
            cursorPredicate(keys, spec.cursor.position, ID, reversed),
          ],
    joins: [...filterJoins, ...projection.joins],
    keys,
    limit: spec.limit + 1,
    membership: view.membership(BASE_ALIAS),
    offset: spec.offset,
    projection,
    relation,
    reversed,
  };

  // The branch form runs with custom plans and no parallel workers, the
  // plan the storage benchmark measured; the settings are restored before
  // any other statement (decision 0008).
  const page =
    parts.branches.length > 1
      ? yield* withBranchTuning(
          readRows(branchedPage(parts), { unprepared: true })
        )
      : yield* readRows(plainPage(parts));

  const read = page.slice(0, spec.limit);
  const rows = reversed ? read.toReversed() : read;
  const last = rows.at(-1);

  // After a `before` page, records follow it (the cursor's own position).
  const hasMore = reversed
    ? last !== undefined
    : page.length > spec.limit && last !== undefined;

  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor(spec.sortKeys, {
          id: last.id ?? "",
          values: keys.map((_, index) => last[`k${index}`] ?? null),
        })
      : null;

  const records = rows.map(projection.decode);

  if (!spec.withCount) {
    return { hasMore, nextCursor, records } satisfies Page;
  }

  const [counted] = yield* readRows(
    sql`SELECT count(*)::text AS "count"
FROM ${relation} AS ${identSql(BASE_ALIAS)}${optionalJoins(filterJoins)}
WHERE ${whereAll(conditions)}`
  );

  return {
    count: Number(counted?.count ?? "0"),
    hasMore,
    nextCursor,
    records,
  } satisfies Page;
});

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

  const allowed = Option.getOrUndefined(
    yield* compileAllowedFor(scope, classId, request.allowedFor)
  );

  const sortKeys = yield* parseSort(view, request.sort);

  const selection = Option.getOrElse(
    yield* parseFields(scope, view, request.fields),
    () => defaultSelection(view)
  );

  const limit = yield* parseLimit(request.limit);
  const withCount = yield* parseFlag("count", request.count);
  const withLabels = yield* parseFlag("labels", request.labels);

  const position =
    request.cursor === undefined
      ? undefined
      : yield* decodeCursor(sortKeys, request.cursor);

  const page = yield* readPage(scope, view, {
    cursor:
      position === undefined ? undefined : { direction: "after", position },
    filters: [filter, allowed].flatMap((compiled) =>
      compiled === undefined ? [] : [compiled]
    ),
    form: request.form,
    limit,
    offset: 0,
    selection,
    sortKeys,
    withCount,
    withLabels,
    withTargets: false,
  });

  const body = {
    nextCursor: page.nextCursor,
    records: page.records.map((record) =>
      v1RecordJson(scope, record, withLabels)
    ),
    schemaRevision: revision,
  } satisfies ListResult;

  return page.count === undefined
    ? body
    : ({ ...body, count: page.count } satisfies ListResult);
});

/**
 * Reads one record through a view by ID (Contracts 2.3, 3.5). A record
 * outside the view's subtree or the caller's visibility, and an ID that
 * does not exist or is not a UUID, give the same `NotFound`.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param id - The record ID as the request gave it.
 * @param options - Selection, labels and targets.
 * @returns The decoded record.
 */
export const readOne = Effect.fn("Records.readOne")(function* readOne(
  scope: ReadScope,
  view: ReadView,
  id: string,
  options: {
    readonly selection: readonly SelectedValue[];
    readonly withLabels: boolean;
    readonly withTargets: boolean;
  }
) {
  const parsedId = parseUuid(id.toLowerCase());

  if (!parsedId.ok) {
    return yield* new NotFound();
  }

  const projection = project(
    scope,
    view,
    options.selection,
    options.withLabels,
    options.withTargets
  );

  const [row] = yield* readRows(
    sql`SELECT ${joinSql(projection.columns, ", ")}
FROM ${recordRelation(scope.snapshot, view.classId)} AS ${identSql(BASE_ALIAS)}${optionalJoins(projection.joins)}
WHERE ${ID} = ${textParameter(parsedId.value, "uuid")} AND ${view.visibility(BASE_ALIAS)}`
  );

  return row === undefined ? yield* new NotFound() : projection.decode(row);
});

/**
 * Reads one record through endpoint E (Contracts 2.3, 3.5): the fields of
 * E and its ancestors the caller can read on this record, the system
 * fields, and `class`, the record's concrete class. Child-only fields are
 * not shown through a parent endpoint (read them through the child's). A
 * record outside E's subtree or the caller's visibility, and an ID that
 * does not exist or is not a UUID, give the same `NotFound`.
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
  const view = scope.view(classId);
  const explicit = yield* parseFields(scope, view, request.fields);
  const withLabels = yield* parseFlag("labels", request.labels);

  const decoded = yield* readOne(scope, view, request.id, {
    selection: Option.getOrElse(explicit, () => defaultSelection(view)),
    withLabels,
    withTargets: false,
  });

  return {
    record: v1RecordJson(scope, decoded, withLabels),
    schemaRevision: revision,
  } satisfies JsonObject;
});
