/**
 * The two benchmark callers (Contracts 2.6 "Callers") and the SQL that STD's
 * rule compiler produces for them (Contracts 3.4, 3.5, 5.9).
 *
 * The restricted caller holds one role with these rules:
 *
 * 1. allow read, create, update, delete on `bench.item` records (so on every
 *    class of the hierarchy) when `owner = me OR status = "shared"`;
 * 2. allow read on fields `*` of every class of the hierarchy, and of
 *    `bench.ticket`;
 * 3. deny read on field `item.location` when `priority > 8` (the conditional
 *    field deny);
 * 4. deny read on `bench.laptop` records when `classification = "restricted"`
 *    (the rule attached to `bench.laptop` that reads an L4 field; it applies
 *    per class through `class_id`);
 * 5. allow read on `bench.ticket` records when
 *    `confidential = false OR opened_by = me`;
 * 6. the built-in `authenticated` read on `core.user` records and `name`.
 *
 * The unrestricted caller is the admin with the built-in allow-all rule.
 * Every function returns `null` when the admin needs no predicate.
 */
import type { ClassName } from "./hierarchy.ts";
import { classDef, subtree } from "./hierarchy.ts";
import type { Params } from "./sql-text.ts";
import { classIn } from "./sql-text.ts";
import type { Relation } from "./storage-model.ts";

/** Who issues a request. */
export interface Caller {
  readonly kind: "admin" | "restricted";
  /** The acting user's ID (`me`). */
  readonly userId: string;
}

/** The constants of the restricted caller's rule conditions. */
export const restrictedRules = {
  laptopDeniedClassification: "restricted",
  locationDeniedAbovePriority: 8,
  sharedStatus: "shared",
} as const;

const restrictedClass: ClassName = "laptop";

// Rule 1's condition: `owner = me OR status = "shared"`.
const ownedOrShared = (
  relation: Relation,
  caller: Caller,
  params: Params
): string => {
  const owner = `${relation.column("item", "owner")} = ${params.bind(caller.userId, "uuid")}`;
  const status = `${relation.column("item", "status")} = ${params.bind(restrictedRules.sharedStatus, "text")}`;

  return `(${owner} OR ${status})`;
};

// NOT of rule 4's condition, in negation normal form (Contracts 5.9).
const laptopNotDenied = (relation: Relation, params: Params): string => {
  const column = relation.column(restrictedClass, "classification");

  return `(${column} <> ${params.bind(restrictedRules.laptopDeniedClassification, "text")} OR ${column} IS NULL)`;
};

/**
 * Row visibility at an endpoint. Classes without their own rules share the
 * parent's predicate; the laptop group gets its own (Contracts 3.5).
 *
 * @param relation - The endpoint's relation.
 * @param endpoint - The endpoint's class.
 * @param caller - Who asks.
 * @param params - Where rule constants are bound.
 * @returns The predicate, or `null` when every record is visible.
 */
export const recordVisibility = (
  relation: Relation,
  endpoint: ClassName,
  caller: Caller,
  params: Params
): string | null => {
  if (caller.kind === "admin") {
    return null;
  }

  const base = ownedOrShared(relation, caller, params);
  const members = subtree(endpoint);

  if (!members.some((member) => member.name === restrictedClass)) {
    return base;
  }

  const notDenied = laptopNotDenied(relation, params);

  if (members.length === 1) {
    return `(${base} AND ${notDenied})`;
  }

  const others: string[] = [];

  for (const member of members) {
    if (member.name !== restrictedClass) {
      others.push(member.id);
    }
  }

  const classId = relation.system("class_id");
  const laptopGroup = `(${classIn(classId, [classDef(restrictedClass).id])} AND ${base} AND ${notDenied})`;

  return `((${classIn(classId, others)} AND ${base}) OR ${laptopGroup})`;
};

/**
 * The condition of the write rules (rule 1).
 *
 * @param relation - The endpoint's relation.
 * @param caller - Who writes.
 * @param params - Where rule constants are bound.
 * @returns The predicate, or `null` for the admin.
 */
export const recordWriteAllowed = (
  relation: Relation,
  caller: Caller,
  params: Params
): string | null =>
  caller.kind === "admin" ? null : ownedOrShared(relation, caller, params);

/**
 * When a conditional field is readable. Only `item.location` is conditional.
 *
 * @param relation - The endpoint's relation.
 * @param field - The field's class and name.
 * @param caller - Who reads.
 * @param params - Where rule constants are bound.
 * @returns The predicate, or `null` when the field is always readable.
 */
export const fieldReadable = (
  relation: Relation,
  field: { readonly cls: ClassName; readonly name: string },
  caller: Caller,
  params: Params
): string | null => {
  if (
    caller.kind === "admin" ||
    field.cls !== "item" ||
    field.name !== "location"
  ) {
    return null;
  }

  const priority = relation.column("item", "priority");

  const limit = params.bind(
    String(restrictedRules.locationDeniedAbovePriority),
    "integer"
  );

  return `(${priority} <= ${limit} OR ${priority} IS NULL)`;
};

/**
 * Ticket row visibility (rule 5).
 *
 * @param alias - The ticket table's alias.
 * @param caller - Who reads.
 * @param params - Where rule constants are bound.
 * @returns The predicate, or `null` for the admin.
 */
export const ticketVisibility = (
  alias: string,
  caller: Caller,
  params: Params
): string | null => {
  if (caller.kind === "admin") {
    return null;
  }

  const notConfidential = `${alias}.confidential = ${params.bind("false", "boolean")}`;

  return `(${notConfidential} OR ${alias}.opened_by = ${params.bind(caller.userId, "uuid")})`;
};

/**
 * The shared row rule split into disjoint branches, for the branch form of
 * the read compiler: branch k is disjunct k of rule 1 AND the negations (in
 * negation normal form) of the disjuncts before it, so each record falls in
 * exactly one branch and each branch can use its own index.
 *
 * @param relation - The relation the branch reads.
 * @param caller - Who reads.
 * @param params - Where rule constants are bound.
 * @returns The branch predicates, or `null` for the admin.
 */
export const ruleBranches = (
  relation: Relation,
  caller: Caller,
  params: Params
): readonly string[] | null => {
  if (caller.kind === "admin") {
    return null;
  }

  const owner = relation.column("item", "owner");
  const status = relation.column("item", "status");
  const me = params.bind(caller.userId, "uuid");
  const shared = params.bind(restrictedRules.sharedStatus, "text");

  return [
    `${owner} = ${me}`,
    `(${status} = ${shared} AND (${owner} <> ${me} OR ${owner} IS NULL))`,
  ];
};

/**
 * The per-class part of row visibility once the shared rule is factored out:
 * `(class_id IN (others) OR (class_id = laptop AND NOT denied))`. Together
 * with the shared rule it equals `recordVisibility`, since every record's
 * class is in subtree(endpoint).
 *
 * @param relation - The relation the branch reads.
 * @param endpoint - The endpoint's class.
 * @param caller - Who reads.
 * @param params - Where rule constants are bound.
 * @returns The guard, or `null` when no class-specific rule applies.
 */
export const classGuard = (
  relation: Relation,
  endpoint: ClassName,
  caller: Caller,
  params: Params
): string | null => {
  const members = subtree(endpoint);

  if (
    caller.kind === "admin" ||
    !members.some((member) => member.name === restrictedClass)
  ) {
    return null;
  }

  const notDenied = laptopNotDenied(relation, params);
  const others: string[] = [];

  for (const member of members) {
    if (member.name !== restrictedClass) {
      others.push(member.id);
    }
  }

  if (others.length === 0) {
    return notDenied;
  }

  const classId = relation.system("class_id");
  const laptopGroup = `(${classIn(classId, [classDef(restrictedClass).id])} AND ${notDenied})`;

  return `(${classIn(classId, others)} OR ${laptopGroup})`;
};
