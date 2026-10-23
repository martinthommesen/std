/**
 * The compiled read SQL of one caller (Contracts 3.4 to 3.6): per class, the
 * visible schema, the row-visibility predicate and the masked expression of
 * every field, over any alias of the class's relation (`relation.ts`).
 *
 * - An always-readable field is its bare column; a conditional one is
 *   `CASE WHEN <mask> THEN col END`, so a hidden value never leaves the
 *   database and behaves exactly like empty wherever it is used (the
 *   masking rule). A field outside the visible schema is `NULL`.
 * - Visibility is `class_id IN subtree(E) AND ((class_id IN g1 AND p1) OR ...)`.
 * - Password and secret values are never selected: their output is
 *   `col IS NOT NULL` under the same mask (`{"set": bool}`, Contracts 6.5).
 *
 * The same scope compiles the base record's view and the views of reference
 * targets, so a joined target gets its own visibility as the join guard and
 * its own masks (Contracts 3.6). Writes re-read through the same predicates.
 */
import type { Caller } from "@std/access/rules";
import { knowsTable } from "@std/access/rules";
import { visibleSchema } from "@std/access/visible-schema";
import type { VisibleSchema } from "@std/access/visible-schema";
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

import { branchesSql, classIn, groupsSql, TRUE_SQL } from "./access-sql.ts";
import type { AccessContext } from "./access-sql.ts";
import { apiNameIndex, SYSTEM_FIELDS, systemField } from "./read-field.ts";
import type { ReadField } from "./read-field.ts";

/** What one caller can read of one class, as SQL over any alias. */
export interface ReadView {
  /** The endpoint's class (or the record's concrete class, for `exact`). */
  readonly classId: DefinitionId;
  /** The concrete classes whose records this view lists. */
  readonly classIds: readonly DefinitionId[];
  readonly schema: VisibleSchema;
  /** System fields, then the visible definition fields. */
  readonly fields: readonly ReadField[];
  /** A readable field by name (system fields included). */
  readonly byName: (name: string) => ReadField | undefined;
  /**
   * A readable field by its `/api/v1` name (`apiNameOfField`); a name two
   * fields share (a clash older than the rule, Contracts 10.2) and `class`
   * (`@type`) resolve to nothing.
   */
  readonly byApiName: (apiName: string) => ReadField | undefined;
  /** A readable field by ID (system fields by their synthetic IDs). */
  readonly byId: (fieldId: DefinitionId) => ReadField | undefined;
  /** Whether the caller can see any record of this view at all. */
  readonly anyVisible: boolean;
  /** Row visibility over a relation alias. */
  readonly visibility: (alias: string) => SqlFragment;
  /**
   * The rows of `subtree(E)` (or of the one class): the part of
   * `visibility` that is not a rule.
   */
  readonly membership: (alias: string) => SqlFragment;
  /**
   * The visibility rules split at their top-level ORs, for the branch
   * form of lists: `membership AND (b1 OR b2 ...)` equals `visibility`.
   */
  readonly visibilityBranches: (alias: string) => readonly SqlFragment[];
  /** Whether the field is readable on the row: `TRUE` when always. */
  readonly readable: (alias: string, field: ReadField) => SqlFragment;
  /** Whether the field is readable on every visible row. */
  readonly isAlways: (field: ReadField) => boolean;
  /** The masked value expression. */
  readonly value: (alias: string, field: ReadField) => SqlFragment;
  /** The value to return: like `value`, but `IS NOT NULL` for write-only types. */
  readonly output: (alias: string, field: ReadField) => SqlFragment;
}

/** One caller's compiled reads at one revision. */
export interface ReadScope {
  readonly snapshot: ConfigSnapshot;
  readonly caller: Caller;
  readonly context: AccessContext;
  /**
   * The view of a class: subtree(T), or with `exact` only T itself (a
   * record whose concrete class is known).
   */
  readonly view: (classId: DefinitionId, exact?: boolean) => ReadView;
}

const isWriteOnly = (field: ReadField): boolean =>
  field.type.kind === "password" || field.type.kind === "secret";

const classNameExpression = (
  snapshot: ConfigSnapshot,
  classIds: readonly DefinitionId[],
  alias: string
): SqlFragment => {
  const branches = classIds.map(
    (classId) =>
      sql`WHEN ${textParameter(classId, "uuid")} THEN ${textParameter(snapshot.qualifiedNameOf(classId) ?? "", "text")}`
  );

  // A view with no known class has no rows to name: a typed NULL, since
  // `CASE x END` without a branch is a syntax error.
  return branches.length === 0
    ? rawSql("CAST(NULL AS text)")
    : sql`(CASE ${identSql(alias, "class_id")} ${joinSql(branches, " ")} END)`;
};

const makeView = (
  scope: Omit<ReadScope, "view">,
  classId: DefinitionId,
  exact: boolean
): ReadView => {
  const { snapshot, caller, context } = scope;
  const schema = visibleSchema(snapshot, caller, classId, { exact });

  const definitionFields: ReadField[] = schema.fields.map((entry) => ({
    classId: entry.field.classId,
    id: entry.field.id,
    name: entry.field.name,
    retired: entry.field.state === "retired",
    type: entry.field.type,
  }));

  const fields = [
    ...SYSTEM_FIELDS.map((name) => systemField(name, classId)),
    ...definitionFields,
  ];

  const byName = new Map(fields.map((field) => [field.name, field]));
  const byApiName = apiNameIndex(fields);
  const byId = new Map(fields.map((field) => [field.id, field]));

  const knownClasses = schema.classIds.filter((id) =>
    knowsTable(snapshot, caller, id)
  );

  const isAlways = (field: ReadField): boolean =>
    field.system !== undefined ||
    schema.byId(field.id)?.readability === "always";

  const readable = (alias: string, field: ReadField): SqlFragment => {
    if (isAlways(field)) {
      return TRUE_SQL;
    }

    const entry = schema.byId(field.id);

    return entry === undefined
      ? rawSql("FALSE")
      : groupsSql(snapshot, { groups: entry.groups }, alias, context);
  };

  const column = (alias: string, field: ReadField): SqlFragment =>
    field.system === "class"
      ? classNameExpression(snapshot, knownClasses, alias)
      : identSql(alias, field.name);

  const masked = (alias: string, field: ReadField, expression: SqlFragment) => {
    if (byId.get(field.id) === undefined) {
      return rawSql("NULL");
    }

    return isAlways(field)
      ? expression
      : sql`(CASE WHEN ${readable(alias, field)} THEN ${expression} END)`;
  };

  return {
    anyVisible: schema.rows.groups.length > 0,
    byApiName: (apiName) => byApiName.get(apiName),
    byId: (fieldId) => byId.get(fieldId),
    byName: (name) => byName.get(name),
    classId,
    classIds: schema.classIds,
    fields,
    isAlways,
    membership: (alias) => classIn(alias, schema.classIds),
    output: (alias, field) =>
      masked(
        alias,
        field,
        isWriteOnly(field)
          ? sql`(${column(alias, field)} IS NOT NULL)`
          : column(alias, field)
      ),
    readable,
    schema,
    value: (alias, field) => masked(alias, field, column(alias, field)),
    visibility: (alias) =>
      sql`(${classIn(alias, schema.classIds)} AND ${groupsSql(snapshot, schema.rows, alias, context)})`,
    visibilityBranches: (alias) =>
      branchesSql(snapshot, schema.rows, alias, context),
  };
};

/**
 * A caller's read scope.
 *
 * @param snapshot - The configuration of the request's revision.
 * @param caller - The caller's roles.
 * @param context - `now`, the instance time zone and the acting user.
 * @returns The scope; views are built once per class.
 */
export const makeReadScope = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  context: AccessContext
): ReadScope => {
  const views = new Map<string, ReadView>();
  const base = { caller, context, snapshot };

  return {
    ...base,
    view: (classId, exact = false) => {
      const key = `${exact ? "exact" : "subtree"}:${classId}`;
      const existing = views.get(key);

      if (existing !== undefined) {
        return existing;
      }

      const created = makeView(base, classId, exact);
      views.set(key, created);

      return created;
    },
  };
};
