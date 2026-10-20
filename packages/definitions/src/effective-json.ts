/**
 * The effective JSON form of a definition, stored per revision in
 * `core.definition_revision` (Contracts 4.4) so history can interpret old
 * values with the labels, types and settings of their revision.
 *
 * It holds every configured property. It leaves out the row's record
 * `version` (bookkeeping of the definition table) and the enforcement state
 * and note (operational state of database constraints, not configuration).
 */
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";

import type { Definition } from "./definition.ts";

const OMITTED: ReadonlySet<string> = new Set([
  "version",
  "enforcement",
  "enforcementNote",
]);

/**
 * The effective JSON of a definition.
 *
 * @param definition - Any definition.
 * @returns A JSON object with its configured properties.
 */
export const effectiveJson = (definition: Definition): JsonObject => {
  const json: JsonObject = definition;

  return Object.fromEntries(
    Object.entries(json).filter(([key]) => !OMITTED.has(key))
  );
};

/**
 * The canonical text of a definition's effective JSON, in jsonb key order,
 * for comparisons ("did this definition change?") and for binding as
 * `$n::jsonb`.
 *
 * @param definition - Any definition.
 * @returns The canonical JSON text.
 */
export const effectiveText = (definition: Definition): string =>
  stringifyJson(effectiveJson(definition));

/**
 * Whether two definitions have the same effective JSON.
 *
 * @param left - A definition.
 * @param right - Another definition.
 * @returns True when no configured property differs.
 */
export const sameEffective = (left: Definition, right: Definition): boolean =>
  effectiveText(left) === effectiveText(right);
