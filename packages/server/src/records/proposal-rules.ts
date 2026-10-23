/** Field rules shared by saves and form proposals, including immutable owner references. */
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { fieldRulesOf, rulesOnUpdate } from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import type { SaveInput } from "./save-pipeline.ts";
import type { RulesById } from "./write-validation.ts";

// The write rules of every field of a class (`@std/definitions/record-rules`),
// the same ones the browser's `recordSchema` applies to the metadata: on
// an update an owner reference is read-only (4.9), and the system effect
// `aggregate` writes read-only fields like the service's own values.
/** Builds the save rules, including immutable owner references on update.
 * @param snapshot - The effective configuration.
 * @param fields - Effective fields indexed by stable ID.
 * @param on - The operation and system assignment mode.
 * @returns Field rules shared by saving and form-state.
 */
export const rulesById = (
  snapshot: ConfigSnapshot,
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  on: { readonly update: boolean; readonly input: SaveInput }
): RulesById =>
  new Map(
    [...fields].map(([fieldId, field]) => {
      const rules = fieldRulesOf(snapshot, field);
      const system = on.input.system === "aggregate";
      const writable = system ? { ...rules, readOnly: false } : rules;

      return [fieldId, on.update ? rulesOnUpdate(writable) : writable];
    })
  );
