import type { Decision } from "@std/access/decision";
import type { Caller, FieldAction } from "@std/access/rules";
/**
 * Access predicates as SQL (Contracts 3.5, 3.9, 5.10): the decisions of
 * `@std/access` compiled with `@std/conditions` over a record relation
 * (`relation.ts`). Reads use them for row visibility and field masks;
 * writes reuse them for the existing-state and proposed-state checks, so
 * there is one evaluator.
 *
 * Access-rule conditions read with full access ("as system"): their columns
 * are the bare columns of the relation, never masked. Every value is a bound
 * parameter.
 *
 * A group of classes compiles to `("a"."class_id" = ANY($ids) AND p)`, and
 * a list of groups to their `OR`; no group is `FALSE`. A stored condition
 * that no longer checks against the snapshot compiles to `FALSE` (fail
 * closed: it can only take access away).
 */
import type { ClassGroup, Grouped } from "@std/access/visible-schema";
import { fieldGroups, recordGroups } from "@std/access/visible-schema";
import { checkCondition } from "@std/conditions/check";
import { resolveCondition } from "@std/conditions/resolve";
import { compileCondition } from "@std/conditions/sql";
import {
  arrayParameter,
  identSql,
  joinSql,
  rawSql,
  sql,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { classViewOf } from "@std/definitions/condition-view";
import type { AccessAction } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

/** What access-rule conditions are resolved with (Contracts 5.7, 5.10). */
export interface AccessContext {
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
  /** The instance's time zone: access rules never use the user's. */
  readonly timeZone: string;
  /** The acting user. */
  readonly me: DefinitionId;
}

/** `TRUE`. */
export const TRUE_SQL: SqlFragment = rawSql("TRUE");

/** `FALSE`. */
export const FALSE_SQL: SqlFragment = rawSql("FALSE");

/**
 * Compiles one decision for records of one class group.
 *
 * @param snapshot - The configuration.
 * @param decision - The decision.
 * @param classId - A class of the group (the condition's fields are on its lineage).
 * @param alias - The alias of the record relation.
 * @param context - `now`, time zone and `me`.
 * @returns A predicate for `WHERE` (it may be NULL only where it is false).
 */
export const decisionSql = (
  snapshot: ConfigSnapshot,
  decision: Decision,
  classId: DefinitionId,
  alias: string,
  context: AccessContext
): SqlFragment => {
  if (decision.kind !== "conditional") {
    return decision.kind === "always" ? TRUE_SQL : FALSE_SQL;
  }

  const checked = checkCondition(decision.condition, {
    classId,
    profile: "accessRule",
    purpose: "evaluate",
    view: classViewOf(snapshot),
  });

  if (!checked.ok) {
    return FALSE_SQL;
  }

  const resolved = resolveCondition(checked.value, {
    me: context.me,
    now: context.now,
    timeZone: context.timeZone,
  });

  if (!resolved.ok) {
    return FALSE_SQL;
  }

  const compiled = compileCondition(resolved.value, {
    alias,
    hooks: {
      column: (source, field) => identSql(source.alias, field.name),
      join: () => {
        throw new RangeError("Access-rule conditions follow no reference.");
      },
    },
    joinAliasPrefix: `${alias}_rule`,
  });

  return compiled.predicate;
};

/**
 * `"a"."class_id" = ANY($ids)`.
 *
 * @param alias - The relation alias.
 * @param classIds - The classes.
 * @returns The membership test.
 */
export const classIn = (
  alias: string,
  classIds: readonly DefinitionId[]
): SqlFragment =>
  sql`${identSql(alias, "class_id")} = ANY(${arrayParameter(classIds, "uuid")})`;

const groupSql = (
  snapshot: ConfigSnapshot,
  group: ClassGroup,
  alias: string,
  context: AccessContext
): SqlFragment => {
  const [first] = group.classIds;

  if (first === undefined) {
    return FALSE_SQL;
  }

  const membership = classIn(alias, group.classIds);

  return group.decision.kind === "always"
    ? membership
    : sql`(${membership} AND ${decisionSql(snapshot, group.decision, first, alias, context)})`;
};

/**
 * Compiles grouped decisions: `(class_id IN g1 AND p1) OR ...`.
 *
 * @param snapshot - The configuration.
 * @param grouped - The groups.
 * @param alias - The relation alias.
 * @param context - `now`, time zone and `me`.
 * @returns The predicate, `FALSE` when there is no group.
 */
export const groupsSql = (
  snapshot: ConfigSnapshot,
  grouped: Grouped,
  alias: string,
  context: AccessContext
): SqlFragment => {
  if (grouped.groups.length === 0) {
    return FALSE_SQL;
  }

  const parts = grouped.groups.map((group) =>
    groupSql(snapshot, group, alias, context)
  );

  return parts.length === 1 && parts[0] !== undefined
    ? parts[0]
    : sql`(${joinSql(parts, " OR ")})`;
};

/** A predicate with the decisions it was compiled from. */
export interface CompiledAccess {
  readonly grouped: Grouped;
  readonly predicate: SqlFragment;
}

/**
 * The record predicate of an action over some classes: row visibility for
 * `read`, the record check of a write (existing and proposed state).
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - The action.
 * @param classIds - The concrete classes (subtree(E), or one class).
 * @param alias - The relation alias.
 * @param context - `now`, time zone and `me`.
 * @returns The grouped decisions and the predicate.
 */
export const recordPredicate = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: AccessAction,
  classIds: readonly DefinitionId[],
  alias: string,
  context: AccessContext
): CompiledAccess => {
  const grouped = recordGroups(snapshot, caller, action, classIds);

  return { grouped, predicate: groupsSql(snapshot, grouped, alias, context) };
};

/**
 * The field predicate of an action over some classes: the read mask, or
 * the field check of a create or update.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param action - Read, create or update.
 * @param classIds - The concrete classes.
 * @param fieldId - The field.
 * @param alias - The relation alias.
 * @param context - `now`, time zone and `me`.
 * @returns The grouped decisions and the predicate.
 */
export const fieldPredicate = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: FieldAction,
  classIds: readonly DefinitionId[],
  fieldId: DefinitionId,
  alias: string,
  context: AccessContext
): CompiledAccess => {
  const grouped = fieldGroups(snapshot, caller, action, classIds, fieldId);

  return { grouped, predicate: groupsSql(snapshot, grouped, alias, context) };
};
