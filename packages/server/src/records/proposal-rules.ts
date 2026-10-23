/** Field rules shared by saves and form proposals, including immutable owner references. */
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { fieldRulesOf, rulesOnUpdate } from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import type { SaveInput } from "./save-input.ts";
import type { RulesById } from "./write-validation.ts";

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
