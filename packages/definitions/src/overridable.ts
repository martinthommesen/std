/**
 * Which properties of a shipped definition an admin may override locally
 * (Contracts 8.2), and the rules an override value must follow.
 *
 * An admin edit to a definition owned by `core` or an app set is stored as
 * one override per property; the effective record is the shipped base with
 * the overrides applied. Every other property belongs to the set and
 * changes only with a new set version.
 *
 * - field: label, help text, default, and tightening of required and
 *   read-only (never name or type);
 * - table: label and display field;
 * - role: label;
 * - access rule: `active` only;
 * - choice: label, order and hidden (shipped choices are never deleted);
 * - layout: its element list, as one property (a layout is overridden as a
 *   whole);
 * - saved filter: its label, and its condition as one property (decision
 *   0019), so a local edit replaces the whole condition;
 * - field: also an auto-numbered field's prefix;
 * - protected definitions: label and help text only (Contracts 1.8), so a
 *   protected access rule cannot be disabled.
 *
 * Record rules join the list with their feature (Step 3). Max-length tightening of a field is listed in 8.2 but
 * lives inside the field's type, which v0.1 never changes, so it is not
 * overridable yet.
 */
import type { JsonValue } from "@std/values/json-value";

import type { Definition, DefinitionKind } from "./definition.ts";

/** Overridable properties of unprotected definitions, per kind. */
export const OVERRIDABLE: Readonly<Record<DefinitionKind, readonly string[]>> =
  {
    accessRule: ["active"],
    choice: ["hidden", "label", "order"],
    class: ["displayFieldId", "label"],
    field: [
      "default",
      "helpText",
      "label",
      "numberPrefix",
      "readOnly",
      "required",
    ],
    grant: [],
    index: [],
    layout: ["elements"],
    namespace: [],
    override: [],
    permission: [],
    role: ["label"],
    savedFilter: ["condition", "label"],
    subscription: [],
  };

/** What a protected definition accepts (Contracts 1.8). */
export const PROTECTED_OVERRIDABLE: readonly string[] = ["helpText", "label"];

/** Properties that may only tighten: `true` overrides a shipped `false`. */
const TIGHTEN_ONLY: ReadonlySet<string> = new Set(["readOnly", "required"]);

/**
 * The properties of a definition an admin may override.
 *
 * @param definition - A shipped definition.
 * @returns The overridable property names, sorted.
 */
export const overridableProperties = (
  definition: Definition
): readonly string[] =>
  definition.protected
    ? PROTECTED_OVERRIDABLE.filter((property) => property in definition)
    : OVERRIDABLE[definition.kind];

/**
 * Whether a definition is shipped by a set, so admin edits become
 * overrides (Contracts 8.1).
 *
 * @param definition - Any definition.
 * @returns True for `core` and app definitions.
 */
export const isShipped = (definition: Definition): boolean =>
  definition.owner.layer !== "local";

/**
 * Why an override value is not allowed, if it is not.
 *
 * @param definition - The shipped definition.
 * @param property - The property to override.
 * @param value - The local value.
 * @param shipped - The shipped (base) value.
 * @returns A message naming the property, or undefined when allowed.
 */
export const overrideProblem = (
  definition: Definition,
  property: string,
  value: JsonValue,
  shipped: JsonValue
): string | undefined => {
  if (!overridableProperties(definition).includes(property)) {
    return definition.protected
      ? `${property} of a protected ${definition.kind} cannot be changed; only label and help text can be overridden.`
      : `${property} of a shipped ${definition.kind} cannot be overridden; it changes only with a new version of its set.`;
  }

  if (TIGHTEN_ONLY.has(property) && shipped === true && value !== true) {
    return `${property} of a shipped ${definition.kind} can only be tightened.`;
  }

  return undefined;
};
