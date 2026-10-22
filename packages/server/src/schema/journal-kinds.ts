/**
 * The change kinds a journal entry records per operation (Contracts 1.5,
 * 6.4), so stale-request checks can tell which changes are relevant
 * without comparing definitions: `fieldAdded`, `fieldRenamed`,
 * `fieldRetired`, `fieldReactivated`, `fieldPurged`, `requiredChanged`,
 * `readOnlyChanged`, `settingsChanged`, `labelChanged`, `tableRenamed`,
 * `tableRetired`, `tablePurged`, `indexDropped` and the like for other
 * kinds (`roleRetired`, `accessRuleDeleted`, ...).
 */
import type { Definition } from "@std/definitions/definition";
import type { JsonObject } from "@std/values/json-value";

const nounOf = (definition: Definition): string =>
  definition.kind === "class" ? "table" : definition.kind;

const removedKind = (definition: Definition): string => {
  if (definition.kind === "index") {
    return "indexDropped";
  }

  const purged = definition.kind === "field" || definition.kind === "class";

  return `${nounOf(definition)}${purged ? "Purged" : "Deleted"}`;
};

const stateKinds = (before: Definition, after: Definition): string[] => {
  if (before.state === after.state) {
    return [];
  }

  if (after.state === "purged") {
    return [removedKind(after)];
  }

  return [
    `${nounOf(after)}${after.state === "retired" ? "Retired" : "Reactivated"}`,
  ];
};

const FIELD_PROPERTY_KINDS: readonly (readonly [string, string])[] = [
  ["required", "requiredChanged"],
  ["readOnly", "readOnlyChanged"],
  ["default", "settingsChanged"],
  ["type", "typeChanged"],
  ["label", "labelChanged"],
  ["helpText", "labelChanged"],
];

const propertyKinds = (before: Definition, after: Definition): string[] => {
  if (before.kind !== "field" || after.kind !== "field") {
    return [];
  }

  const was: JsonObject = before;
  const now: JsonObject = after;

  return FIELD_PROPERTY_KINDS.flatMap(([property, kind]) => {
    if (JSON.stringify(was[property]) === JSON.stringify(now[property])) {
      return [];
    }

    // A type that keeps its kind changed a setting: a reference's
    // allowed-records condition, the only one that may change (decision
    // 0020).
    return property === "type" && before.type.kind === after.type.kind
      ? ["settingsChanged"]
      : [kind];
  });
};

const nameOf = (definition: Definition): string | undefined =>
  "name" in definition ? (definition.name ?? undefined) : undefined;

/**
 * The change kinds of one definition's change.
 *
 * @param before - The definition before, undefined when created.
 * @param after - The definition after.
 * @returns The kinds, without duplicates; `changed` when none applies.
 */
export const changeKindsOf = (
  before: Definition | undefined,
  after: Definition
): readonly string[] => {
  if (before === undefined) {
    return [`${nounOf(after)}Added`];
  }

  const kinds = [
    ...(nameOf(before) === nameOf(after) ? [] : [`${nounOf(after)}Renamed`]),
    ...stateKinds(before, after),
    ...propertyKinds(before, after),
  ];

  return kinds.length === 0 ? ["changed"] : [...new Set(kinds)];
};
