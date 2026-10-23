/**
 * Condition profiles (Contracts 5.10) and which operators fit which field
 * types (Contracts 5.4, 6.5). The checker and the differential test's
 * coverage gate both read these tables, so "permitted" means one thing.
 */
import {
  comparisonClass,
  FIELD_KINDS,
  isOrdered,
  isTextKind,
} from "@std/values/field-type";
import type { ConditionProfile, FieldKind } from "@std/values/field-type";

import type { AtomOperator } from "./ast.ts";

/** Every profile. */
export const PROFILES: readonly ConditionProfile[] = [
  "filter",
  "accessRule",
  "formRule",
  "recordRule",
  "subscription",
];

/** A context value a profile may use. */
export type ContextName = "me" | "now" | "myGroups";

/** Options that change a profile's limits by delivery stage. */
export interface ProfileOptions {
  /** Allow `myGroups` in filters and access rules (Step 3). Default false. */
  readonly myGroups?: boolean;
  /** Path hops in access rules: 0 in Step 1, 1 from Step 3. Default 0. */
  readonly accessRuleHops?: 0 | 1;
}

/** The limits of one profile. */
export interface ProfileRules {
  readonly profile: ConditionProfile;
  /** Whether `changed` is allowed. */
  readonly changed: boolean;
  /** Whether `previous` paths are allowed. */
  readonly previous: boolean;
  /** The context values allowed. `now` also covers `rel` and `inPeriod`. */
  readonly context: ReadonlySet<ContextName>;
  /** The most reference hops a path may take. */
  readonly maxHops: number;
}

const FORM_RULE_HOPS = 1;
const RECORD_RULE_HOPS = 3;

/**
 * The rules of a profile.
 *
 * Form rules may follow only preloaded paths; the form preloads one hop, so
 * `maxHops` is 1 and the checker's `isPreloaded` option narrows it further.
 *
 * @param profile - The profile.
 * @param options - Stage options.
 * @returns The profile's limits.
 */
export const profileRules = (
  profile: ConditionProfile,
  options: ProfileOptions = {}
): ProfileRules => {
  const groups: readonly ContextName[] =
    options.myGroups === true ? ["myGroups"] : [];

  switch (profile) {
    case "filter": {
      return {
        changed: false,
        context: new Set<ContextName>(["me", "now", ...groups]),
        maxHops: 1,
        previous: false,
        profile,
      };
    }

    case "accessRule": {
      return {
        changed: false,
        context: new Set<ContextName>(["me", "now", ...groups]),
        maxHops: options.accessRuleHops ?? 0,
        previous: false,
        profile,
      };
    }

    case "formRule": {
      return {
        changed: true,
        context: new Set<ContextName>(["me", "now"]),
        maxHops: FORM_RULE_HOPS,
        previous: true,
        profile,
      };
    }

    case "recordRule": {
      return {
        changed: true,
        context: new Set<ContextName>(["me", "now"]),
        maxHops: RECORD_RULE_HOPS,
        previous: true,
        profile,
      };
    }

    case "subscription": {
      return {
        changed: false,
        context: new Set<ContextName>(["now"]),
        maxHops: 0,
        previous: false,
        profile,
      };
    }

    default: {
      return profile satisfies never;
    }
  }
};

const EQUALITY_KINDS: readonly FieldKind[] = FIELD_KINDS.filter(
  (kind) => comparisonClass(kind) !== null
);

const ORDERED_KINDS: readonly FieldKind[] = FIELD_KINDS.filter(isOrdered);

const TEXT_KINDS: readonly FieldKind[] = FIELD_KINDS.filter(isTextKind);

const EMPTY_KINDS: readonly FieldKind[] = [
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "date",
  "dateTime",
  "choice",
  "reference",
  "uuid",
  "password",
  "secret",
  "json",
  "condition",
];

const CHANGED_KINDS: readonly FieldKind[] = [
  ...EQUALITY_KINDS,
  "json",
  "condition",
];

const PERIOD_KINDS: readonly FieldKind[] = ["date", "dateTime"];

/**
 * The field kinds each operator applies to (Contracts 5.4). Password and
 * secret allow only `empty` and `notEmpty` (Contracts 6.5); booleans are
 * never empty.
 */
export const OPERATOR_KINDS: Readonly<
  Record<AtomOperator, readonly FieldKind[]>
> = {
  changed: CHANGED_KINDS,
  contains: TEXT_KINDS,
  empty: EMPTY_KINDS,
  endsWith: TEXT_KINDS,
  eq: EQUALITY_KINDS,
  ge: ORDERED_KINDS,
  gt: ORDERED_KINDS,
  in: EQUALITY_KINDS,
  inPeriod: PERIOD_KINDS,
  le: ORDERED_KINDS,
  lt: ORDERED_KINDS,
  ne: EQUALITY_KINDS,
  notContains: TEXT_KINDS,
  notEmpty: EMPTY_KINDS,
  notIn: EQUALITY_KINDS,
  startsWith: TEXT_KINDS,
};

/**
 * Whether an operator applies to a field kind.
 *
 * @param operator - The atom operator.
 * @param kind - The left field's kind.
 * @returns True when the pair is in the operator table.
 */
export const operatorFitsKind = (
  operator: AtomOperator,
  kind: FieldKind
): boolean => OPERATOR_KINDS[operator].includes(kind);

/**
 * Whether a profile allows an operator at all.
 *
 * @param rules - The profile's rules.
 * @param operator - The atom operator.
 * @returns False only for `changed` outside form and record rules.
 */
export const profileAllowsOperator = (
  rules: ProfileRules,
  operator: AtomOperator
): boolean => operator !== "changed" || rules.changed;
