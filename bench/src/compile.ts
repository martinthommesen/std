/**
 * A hand-written stand-in for STD's read compiler (Contracts 3.5, 3.6): it
 * turns a list or get request into one SQL statement against a storage
 * model's relation, applying the caller's row visibility in `WHERE`, masks on
 * conditional fields in the selection, filters, sorts and cursors, reference
 * labels through guarded joins, and the null-aware keyset cursor.
 */
import type { Caller } from "./access.ts";
import {
  classGuard,
  fieldReadable,
  recordVisibility,
  recordWriteAllowed,
  ruleBranches,
  ticketVisibility,
} from "./access.ts";
import type { ClassName } from "./hierarchy.ts";
import { endpointFields, fieldDef, ticketClass } from "./hierarchy.ts";
import { afterCursor, orderItem } from "./keyset.ts";
import { ticketFieldDef, ticketTable, userTable } from "./models/common.ts";
import type { Compiled, Params } from "./sql-text.ts";
import { makeParams, q } from "./sql-text.ts";
import type {
  ModelContext,
  Relation,
  StorageModel,
  SystemColumn,
} from "./storage-model.ts";
import { systemColumns } from "./storage-model.ts";
import { castOf } from "./values.ts";

/** An endpoint: a class of the hierarchy, or `bench.ticket`. */
export type Endpoint = ClassName | "ticket";

/** A field reference in a filter or sort. */
export type Path =
  | { readonly kind: "field"; readonly cls: ClassName; readonly field: string }
  | { readonly kind: "system"; readonly column: SystemColumn }
  | { readonly kind: "ticket"; readonly field: string }
  /** One hop: a field of the ticket's `item`. */
  | { readonly kind: "item"; readonly field: string };

/** A filter atom (the `eq` and `in` operators of Contracts 5.9). */
export interface Atom {
  readonly path: Path;
  readonly op: "eq" | "in";
  readonly values: readonly string[];
}

/** A sort key. */
export interface SortKey {
  readonly path: Path;
  readonly direction: "asc" | "desc";
}

/** A keyset cursor: the masked sort-key values and `id` of the last row seen. */
export interface Cursor {
  readonly values: readonly (string | null)[];
  readonly id: string;
}

/** A list request. */
export interface ListQuery {
  readonly endpoint: Endpoint;
  readonly filters: readonly Atom[];
  readonly sort: readonly SortKey[];
  readonly limit: number;
  readonly cursor?: Cursor;
}

/** The model, context and caller a request compiles for. */
export interface Target {
  readonly model: StorageModel;
  readonly ctx: ModelContext;
  readonly caller: Caller;
}

const systemCast: Readonly<Record<SystemColumn, string>> = {
  class_id: "uuid",
  created_at: "timestamptz",
  created_by: "uuid",
  id: "uuid",
  updated_at: "timestamptz",
  updated_by: "uuid",
  version: "bigint",
};

const ticketOnly = "this path needs the ticket endpoint";

const hierarchyOnly =
  "hierarchy fields are not reachable from the ticket endpoint";

interface Scope {
  readonly expression: (path: Path) => string;
  readonly cast: (path: Path) => string;
  /** Read before `from`: selecting a column may add a join. */
  readonly selection: () => readonly string[];
  readonly endpointFilter: string | null;
  readonly visibility: string | null;
  /** The write rule's condition (hierarchy endpoints only). */
  readonly writeAllowed: () => string | null;
  readonly id: string;
  /** Read last: column lookups may add joins. */
  readonly from: () => string;
  /** The endpoint's relation (for tickets: the item relation). */
  readonly relation: Relation;
}

const masked = (column: string, readable: string | null): string =>
  readable === null ? column : `CASE WHEN ${readable} THEN ${column} END`;

const systemSelection = (
  expression: (column: SystemColumn) => string
): readonly string[] =>
  systemColumns.map((column) =>
    column === "id"
      ? `${expression(column)}::text AS id`
      : `${expression(column)} AS ${column}`
  );

const fieldSelection = (
  relation: Relation,
  caller: Caller,
  params: Params,
  endpoint: ClassName
): readonly string[] =>
  endpointFields(endpoint).flatMap(({ cls, field }) => {
    const readable = fieldReadable(
      relation,
      { cls, name: field.name },
      caller,
      params
    );

    const column = relation.column(cls, field.name);
    const name = q(field.name);

    if (readable === null) {
      return [`${column} AS ${name}`];
    }

    const flag = q(`${field.name}$readable`);

    return [
      `${masked(column, readable)} AS ${name}`,
      `COALESCE(${readable}, false) AS ${flag}`,
    ];
  });

const hierarchyCast = (path: Path): string => {
  switch (path.kind) {
    case "field": {
      return castOf(fieldDef(path.cls, path.field));
    }

    case "system": {
      return systemCast[path.column];
    }

    case "ticket":
    case "item": {
      throw new Error(ticketOnly);
    }

    default: {
      return path satisfies never;
    }
  }
};

const hierarchyScope = (
  target: Target,
  endpoint: ClassName,
  params: Params,
  alias = "i"
): Scope => {
  const { caller } = target;
  const relation = target.model.relation(target.ctx, endpoint, alias);

  const expression = (path: Path): string => {
    switch (path.kind) {
      case "field": {
        return masked(
          relation.column(path.cls, path.field),
          fieldReadable(
            relation,
            { cls: path.cls, name: path.field },
            caller,
            params
          )
        );
      }

      case "system": {
        return relation.system(path.column);
      }

      case "ticket":
      case "item": {
        throw new Error(ticketOnly);
      }

      default: {
        return path satisfies never;
      }
    }
  };

  const owner = relation.column("item", "owner");

  return {
    cast: hierarchyCast,
    endpointFilter: relation.endpointFilter(),
    expression,
    from: () =>
      `${relation.from()} LEFT JOIN ${userTable} ou ON ou.id = ${owner}`,
    id: relation.system("id"),
    relation,
    selection: () => [
      ...systemSelection(relation.system),
      ...fieldSelection(relation, caller, params, endpoint),
      `ou.name AS ${q("owner$label")}`,
    ],
    visibility: recordVisibility(relation, endpoint, caller, params),
    writeAllowed: () => recordWriteAllowed(relation, caller, params),
  };
};

const ticketCast = (path: Path): string => {
  switch (path.kind) {
    case "ticket": {
      return castOf(ticketFieldDef(path.field));
    }

    case "system": {
      return systemCast[path.column];
    }

    case "item": {
      return castOf(fieldDef("item", path.field));
    }

    case "field": {
      throw new Error(hierarchyOnly);
    }

    default: {
      return path satisfies never;
    }
  }
};

const ticketExpression =
  (alias: string, item: Relation, caller: Caller, params: Params) =>
  (path: Path): string => {
    switch (path.kind) {
      case "ticket": {
        return `${alias}.${q(path.field)}`;
      }

      case "system": {
        return `${alias}.${path.column}`;
      }

      case "item": {
        return masked(
          item.column("item", path.field),
          fieldReadable(item, { cls: "item", name: path.field }, caller, params)
        );
      }

      case "field": {
        throw new Error(hierarchyOnly);
      }

      default: {
        return path satisfies never;
      }
    }
  };

const ticketScope = (target: Target, params: Params): Scope => {
  const { caller } = target;
  const alias = "t";
  const item = target.model.relation(target.ctx, "item", "ti");
  const guard = recordVisibility(item, "item", caller, params);
  const expression = ticketExpression(alias, item, caller, params);

  const label = item.column("item", "name");

  const from = (): string => {
    const join = target.model.ticketItemJoin(alias, item);
    const condition = guard === null ? join : `${join} AND ${guard}`;

    return (
      `${ticketTable(target.ctx)} ${alias} LEFT JOIN ${item.from()} ON ${condition} ` +
      `LEFT JOIN ${userTable} tob ON tob.id = ${alias}.opened_by`
    );
  };

  return {
    cast: ticketCast,
    endpointFilter: null,
    expression,
    from,
    id: `${alias}.id`,
    relation: item,
    selection: () => [
      ...systemSelection((column) => `${alias}.${column}`),
      ...ticketClass.fields.map(
        (def) => `${alias}.${q(def.name)} AS ${q(def.name)}`
      ),
      `${label} AS ${q("item$label")}`,
      `tob.name AS ${q("opened_by$label")}`,
    ],
    visibility: ticketVisibility(alias, caller, params),
    writeAllowed: () => {
      throw new Error("tickets are not written by the benchmark");
    },
  };
};

const makeScope = (
  target: Target,
  endpoint: Endpoint,
  params: Params
): Scope =>
  endpoint === "ticket"
    ? ticketScope(target, params)
    : hierarchyScope(target, endpoint, params);

const arrayElement = (value: string): string => {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  return `"${escaped}"`;
};

const arrayLiteral = (values: readonly string[]): string =>
  `{${values.map((value) => arrayElement(value)).join(",")}}`;

const atomSql = (
  scope: Pick<Scope, "expression" | "cast">,
  atom: Atom,
  params: Params
): string => {
  const expression = scope.expression(atom.path);
  const cast = scope.cast(atom.path);

  if (atom.op === "eq") {
    return `${expression} = ${params.bind(atom.values[0] ?? null, cast)}`;
  }

  const arrayCast = `${cast}[]`;

  return `${expression} = ANY(${params.bind(arrayLiteral(atom.values), arrayCast)})`;
};

const whereClause = (conditions: readonly (string | null)[]): string => {
  const present = conditions.filter(
    (condition): condition is string => condition !== null
  );

  return present.length === 0 ? "" : ` WHERE ${present.join(" AND ")}`;
};

interface PreparedKey {
  readonly expression: string;
  readonly direction: "asc" | "desc";
  readonly cast: string;
}

interface Prepared {
  readonly scope: Scope;
  readonly params: Params;
  readonly filters: readonly (string | null)[];
  readonly keys: readonly PreparedKey[];
  readonly orderBy: string;
}

const prepare = (target: Target, query: ListQuery): Prepared => {
  const params = makeParams();
  const scope = makeScope(target, query.endpoint, params);

  const filters = [
    scope.endpointFilter,
    scope.visibility,
    ...query.filters.map((atom) => atomSql(scope, atom, params)),
  ];

  const keys = query.sort.map((key) => ({
    cast: scope.cast(key.path),
    direction: key.direction,
    expression: scope.expression(key.path),
  }));

  const items = [
    ...keys.map((key) => orderItem(key.expression, key.direction)),
    orderItem(scope.id, keys[0]?.direction ?? "asc"),
  ];

  return {
    filters,
    keys,
    orderBy: ` ORDER BY ${items.join(", ")}`,
    params,
    scope,
  };
};

const cursorPredicate = (
  prepared: Prepared,
  cursor: Cursor | undefined
): string | null => {
  if (cursor === undefined) {
    return null;
  }

  const keys = prepared.keys.map((key, index) => ({
    ...key,
    value: cursor.values[index] ?? null,
  }));

  return afterCursor(
    keys,
    { expression: prepared.scope.id, value: cursor.id },
    prepared.params
  );
};

/**
 * Compiles a list request into its page query.
 *
 * @param target - Model, context and caller.
 * @param query - The request.
 * @returns The statement.
 */
export const compileList = (target: Target, query: ListQuery): Compiled => {
  const prepared = prepare(target, query);
  const { filters, orderBy, params, scope } = prepared;
  const cursor = cursorPredicate(prepared, query.cursor);
  const selection = scope.selection().join(", ");
  const text = `SELECT ${selection} FROM ${scope.from()}${whereClause([...filters, cursor])}${orderBy} LIMIT ${query.limit}`;

  return { params: params.values(), text };
};

/**
 * Compiles the count of a list request: the same FROM and WHERE, no cursor
 * (Contracts 3.5).
 *
 * @param target - Model, context and caller.
 * @param query - The request.
 * @returns The statement.
 */
export const compileCount = (target: Target, query: ListQuery): Compiled => {
  const { filters, params, scope } = prepare(target, query);
  const text = `SELECT count(*)::text AS count FROM ${scope.from()}${whereClause(filters)}`;

  return { params: params.values(), text };
};

/**
 * Finds the cursor a client would hold after paging to `depth` rows: the
 * masked sort-key values and `id` of row number `depth`. Not measured.
 *
 * @param target - Model, context and caller.
 * @param query - The request.
 * @param depth - Rows already paged through.
 * @returns The statement; it returns `keys` (text array) and `id`.
 */
export const compileCursorProbe = (
  target: Target,
  query: ListQuery,
  depth: number
): Compiled => {
  const { filters, keys, orderBy, params, scope } = prepare(target, query);
  const values = keys.map((key) => `${key.expression}::text`).join(", ");
  const selection = `ARRAY[${values}]::text[] AS keys, ${scope.id}::text AS id`;
  const text = `SELECT ${selection} FROM ${scope.from()}${whereClause(filters)}${orderBy} OFFSET ${depth - 1} LIMIT 1`;

  return { params: params.values(), text };
};

/**
 * Compiles a get by ID at a hierarchy endpoint. With `flags`, visibility and
 * the write rule are returned as `visible` and `allowed` instead of filtering
 * (the existing-state and proposed-state reads of the save pipeline).
 *
 * @param target - Model, context and caller.
 * @param endpoint - The endpoint's class.
 * @param id - The record ID.
 * @param flags - Return visibility as columns instead of filtering.
 * @returns The statement.
 */
export const compileGet = (
  target: Target,
  endpoint: ClassName,
  id: string,
  flags: boolean
): Compiled => {
  const params = makeParams();
  const scope = hierarchyScope(target, endpoint, params);
  const idCondition = `${scope.id} = ${params.bind(id, "uuid")}`;

  if (!flags) {
    const selection = scope.selection().join(", ");
    const text = `SELECT ${selection} FROM ${scope.from()}${whereClause([idCondition, scope.endpointFilter, scope.visibility])}`;

    return { params: params.values(), text };
  }

  const allowed = scope.writeAllowed();

  const visibleColumn =
    scope.visibility === null
      ? "true AS visible"
      : `COALESCE(${scope.visibility}, false) AS visible`;

  const allowedColumn =
    allowed === null
      ? "true AS allowed"
      : `COALESCE(${allowed}, false) AS allowed`;

  const selection = [...scope.selection(), visibleColumn, allowedColumn].join(
    ", "
  );

  const text = `SELECT ${selection} FROM ${scope.from()}${whereClause([idCondition, scope.endpointFilter])}`;

  return { params: params.values(), text };
};

interface BranchKey {
  readonly expression: string;
  readonly direction: "asc" | "desc";
}

const orderClause = (keys: readonly BranchKey[], id: string): string => {
  const items = [
    ...keys.map((key) => orderItem(key.expression, key.direction)),
    orderItem(id, keys[0]?.direction ?? "asc"),
  ];

  return ` ORDER BY ${items.join(", ")}`;
};

const keysOf = (
  expression: (path: Path) => string,
  query: ListQuery
): readonly BranchKey[] =>
  query.sort.map((key) => ({
    direction: key.direction,
    expression: expression(key.path),
  }));

const branchCount = (target: Target): number => {
  const probe = target.model.relation(target.ctx, "item", "probe");

  return ruleBranches(probe, target.caller, makeParams())?.length ?? 0;
};

const hierarchyBranch = (
  target: Target,
  query: ListQuery,
  params: Params,
  index: number,
  endpoint: ClassName
): string => {
  const scope = hierarchyScope(target, endpoint, params);
  const { relation } = scope;

  const predicate =
    ruleBranches(relation, target.caller, params)?.[index] ?? null;

  const guard = classGuard(relation, endpoint, target.caller, params);
  const filters = query.filters.map((atom) => atomSql(scope, atom, params));
  const orderBy = orderClause(keysOf(scope.expression, query), scope.id);

  const where = whereClause([
    relation.endpointFilter(),
    predicate,
    guard,
    ...filters,
  ]);

  return `SELECT ${scope.id} AS id FROM ${scope.from()}${where}${orderBy} LIMIT ${query.limit}`;
};

const ticketBranch = (
  target: Target,
  query: ListQuery,
  params: Params,
  index: number
): string => {
  const alias = "t";
  const item = target.model.relation(target.ctx, "item", "ti");
  const expression = ticketExpression(alias, item, target.caller, params);
  const predicate = ruleBranches(item, target.caller, params)?.[index] ?? null;
  const guard = classGuard(item, "item", target.caller, params);
  const visibility = ticketVisibility(alias, target.caller, params);

  const filters = query.filters.map((atom) =>
    atomSql({ cast: ticketCast, expression }, atom, params)
  );

  const orderBy = orderClause(keysOf(expression, query), `${alias}.id`);
  const where = whereClause([visibility, predicate, guard, ...filters]);
  const from = `${ticketTable(target.ctx)} ${alias} JOIN ${item.from()} ON ${target.model.ticketItemJoin(alias, item)}`;

  return `SELECT ${alias}.id AS id FROM ${from}${where}${orderBy} LIMIT ${query.limit}`;
};

/**
 * True when the branch form returns the same rows as the plain form. For a
 * hierarchy endpoint it always does: visibility is a WHERE predicate in both.
 * For tickets the plain form keeps a visible ticket whose item is hidden (its
 * item fields and label are just empty), while the branch form reaches
 * tickets only through visible items. The two agree only when the request
 * filters on an item field with `eq` or `in`: such a filter is false for an
 * empty or hidden item, so the plain form drops those tickets too.
 *
 * @param query - The request.
 * @returns Whether the branch form may be used.
 */
export const branchFormApplies = (query: ListQuery): boolean =>
  query.endpoint !== "ticket" ||
  query.filters.some((atom) => atom.path.kind === "item");

/**
 * The branch form of a list request for a restricted caller, which STD's
 * read compiler can generate mechanically from the rule and the request:
 * the row rule's OR is split into disjoint branches (`ruleBranches`), each
 * branch applies the per-class guard, the request's filters and its sort and
 * keeps the first page, and the union is sorted again and joined back for
 * the selection and labels. Each branch can then use its own index. For a
 * reference filter (Q7) the branches reach tickets through the item rule's
 * disjuncts the same way, and only when `branchFormApplies`. First pages
 * only; the admin and every other request get the plain form.
 *
 * @param target - Model, context and caller.
 * @param query - The request (no cursor).
 * @returns The statement.
 */
export const compileBranchedList = (
  target: Target,
  query: ListQuery
): Compiled => {
  const branches = branchCount(target);

  if (branches === 0 || !branchFormApplies(query)) {
    return compileList(target, query);
  }

  if (query.cursor !== undefined) {
    throw new Error("the branch form is measured for first pages only");
  }

  const params = makeParams();
  const { endpoint } = query;
  const indexes = Array.from({ length: branches }, (_unused, index) => index);

  const parts =
    endpoint === "ticket"
      ? indexes.map((index) => ticketBranch(target, query, params, index))
      : indexes.map((index) =>
          hierarchyBranch(target, query, params, index, endpoint)
        );

  const outer = makeScope(target, endpoint, params);
  const selection = outer.selection().join(", ");
  const orderBy = orderClause(keysOf(outer.expression, query), outer.id);
  const page = parts.map((part) => `(${part})`).join(" UNION ALL ");
  const text = `WITH page AS (${page}) SELECT ${selection} FROM ${outer.from()} JOIN page p ON p.id = ${outer.id}${orderBy} LIMIT ${query.limit}`;

  return { params: params.values(), text };
};
