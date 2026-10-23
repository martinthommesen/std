/**
 * The class fixture shared by the unit tests and the differential test: a
 * root class `asset` with one field of every condition-capable type (text and
 * long text in both case settings), a child class `laptop`, and a reference
 * target class `person` that references itself, so paths can take up to
 * three hops.
 */
import type { FieldType } from "@std/values/field-type";

import type { Expr, Path } from "../../src/ast.ts";
import { checkCondition } from "../../src/check.ts";
import type { CheckOptions } from "../../src/check.ts";
import { staticClassView } from "../../src/class-view.ts";
import type { ClassView, FieldInfo } from "../../src/class-view.ts";
import type { ConditionResult, IssueReason } from "../../src/issue.ts";
import { resolveCondition } from "../../src/resolve.ts";
import type { ConditionContext } from "../../src/resolve.ts";
import { identSql } from "../../src/sql-fragment.ts";
import type { SqlHooks } from "../../src/sql.ts";
import type { ResolvedCondition } from "../../src/typed.ts";

/**
 * A fixture stable ID.
 *
 * @param n - A small number.
 * @returns A lowercase UUIDv7-shaped ID.
 */
export const stableId = (n: number): string =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * An asset row's fixture ID, distinct from definition and person IDs.
 *
 * @param n - The row index.
 * @returns A lowercase UUIDv7-shaped ID.
 */
export const rowId = (n: number): string =>
  `00000000-0000-7000-9000-${n.toString(16).padStart(12, "0")}`;

/**
 * A current-image path through fixture fields.
 *
 * @param fields - The fields in path order.
 * @returns The path.
 */
export const path = (...fields: readonly { readonly id: string }[]): Path => ({
  path: fields.map((entry) => entry.id),
});

/**
 * Checks and resolves an expression, preserving either step's refusal.
 *
 * @param expr - The expression.
 * @param options - Its check context.
 * @param context - Its evaluation context.
 * @returns A resolved condition or its refusal.
 */
export const resolveFor = (
  expr: Expr,
  options: CheckOptions,
  context: ConditionContext
): ConditionResult<ResolvedCondition> => {
  const checked = checkCondition(expr, options);

  return checked.ok ? resolveCondition(checked.value, context) : checked;
};

/**
 * Checks and resolves a fixture expression, throwing on either refusal.
 *
 * @param expr - The expression.
 * @param options - Its check context.
 * @param context - Its evaluation context.
 * @returns The resolved condition.
 */
export const prepareCondition = (
  expr: Expr,
  options: CheckOptions,
  context: ConditionContext
): ResolvedCondition => {
  const resolved = resolveFor(expr, options, context);

  if (!resolved.ok) {
    throw resolved.error;
  }

  return resolved.value;
};

/**
 * The issue reasons of a refused condition, or none for a valid condition.
 *
 * @param result - A check or resolution result.
 * @returns Its issue reasons in their reported order.
 */
export const issueReasons = (
  result: ConditionResult<unknown>
): IssueReason[] =>
  result.ok ? [] : result.error.issues.map((found) => found.reason);

/** Column-by-name compiler hooks for fixtures without references. */
export const identHooks: SqlHooks = {
  column: (source, column) => identSql(source.alias, column.name),
  join: () => {
    throw new Error("No references here.");
  },
};

/** The reference target class. */
export const PERSON = stableId(0x1_00);

/** The root class. */
export const ASSET = stableId(0x2_00);

/** The child class. */
export const LAPTOP = stableId(0x3_00);

/** A fixture field with its column. */
export interface FixtureField extends FieldInfo {
  readonly column: string;
}

let next = 0;

const field = (
  classId: string,
  name: string,
  type: FieldType,
  retired = false
): FixtureField => {
  next += 1;

  return {
    classId,
    column: name,
    id: stableId(classId === PERSON ? 0x1_00 + next : next + 0x10_00),
    name,
    retired,
    type,
  };
};

/** Fields of `person`. */
export const PERSON_FIELDS = {
  code: field(PERSON, "code", { caseSensitive: true, kind: "text" }),
  manager: field(PERSON, "manager", {
    kind: "reference",
    targetClassId: PERSON,
  }),
  name: field(PERSON, "name", { kind: "text" }),
  rank: field(PERSON, "rank", { kind: "integer" }),
  since: field(PERSON, "since", { kind: "date" }),
} as const;

/** Fields of `asset`, one per condition-capable type. */
export const ASSET_FIELDS = {
  active: field(ASSET, "active", { kind: "boolean" }),
  code: field(ASSET, "code", {
    caseSensitive: true,
    kind: "text",
    maxLength: 4000,
  }),
  cost: field(ASSET, "cost", { kind: "decimal", precision: 38, scale: 6 }),
  count: field(ASSET, "count", { kind: "integer" }),
  data: field(ASSET, "data", { kind: "json" }),
  due: field(ASSET, "due", { kind: "date" }),
  external: field(ASSET, "external", { kind: "uuid" }),
  key: field(ASSET, "key", { kind: "password" }),
  name: field(ASSET, "name", { kind: "text", maxLength: 4000 }),
  notes: field(ASSET, "notes", { kind: "longText" }),
  opened: field(ASSET, "opened", { kind: "dateTime" }),
  owner: field(ASSET, "owner", { kind: "reference", targetClassId: PERSON }),
  rule: field(ASSET, "rule", {
    classId: ASSET,
    kind: "condition",
    profile: "filter",
  }),
  serial: field(ASSET, "serial", { kind: "bigInteger" }),
  status: field(ASSET, "status", { kind: "choice" }),
  token: field(ASSET, "token", { kind: "secret" }),
  transcript: field(ASSET, "transcript", {
    caseSensitive: true,
    kind: "longText",
  }),
} as const;

/** Fields of `laptop`. */
export const LAPTOP_FIELDS = {
  docked: field(LAPTOP, "docked", { kind: "reference", targetClassId: PERSON }),
  hostname: field(LAPTOP, "hostname", { kind: "text" }),
  purchased: field(LAPTOP, "purchased", { kind: "date" }),
  ram: field(LAPTOP, "ram", { kind: "integer" }),
} as const;

/** A retired field of `asset`, for the store-time check. */
export const RETIRED_FIELD = field(ASSET, "legacy", { kind: "text" }, true);

/**
 * A boolean on the reference target, so booleans are also read through
 * hidden and empty references. Declared after the others to keep their IDs.
 */
export const PERSON_VIP = field(PERSON, "vip", { kind: "boolean" });

/** Every field of `person`. */
export const PERSON_LIST: readonly FixtureField[] = [
  ...Object.values(PERSON_FIELDS),
  PERSON_VIP,
];

/** Own fields of `asset`. */
export const ASSET_LIST: readonly FixtureField[] = Object.values(ASSET_FIELDS);

/** Own fields of `laptop`. */
export const LAPTOP_LIST: readonly FixtureField[] =
  Object.values(LAPTOP_FIELDS);

/** Every fixture field. */
export const ALL_FIELDS: readonly FixtureField[] = [
  ...PERSON_LIST,
  ...ASSET_LIST,
  ...LAPTOP_LIST,
  RETIRED_FIELD,
];

/** The fixture class view. */
export const fixtureView: ClassView = staticClassView([
  { fields: PERSON_LIST, id: PERSON, parentId: null },
  {
    fields: [...ASSET_LIST, RETIRED_FIELD],
    id: ASSET,
    parentId: null,
  },
  { fields: LAPTOP_LIST, id: LAPTOP, parentId: ASSET },
]);

/**
 * Looks a fixture field up by ID.
 *
 * @param id - The field ID.
 * @returns The field.
 */
export const fixtureField = (id: string): FixtureField => {
  const found = ALL_FIELDS.find((candidate) => candidate.id === id);

  if (found === undefined) {
    throw new Error(`No fixture field ${id}`);
  }

  return found;
};
