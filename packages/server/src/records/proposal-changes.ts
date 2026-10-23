/** Change detection shared by saves and non-persisting form proposals. */
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { storedEquals } from "@std/values/compare";
import type { DecodedInput, StoredValue } from "@std/values/field-value";

import type { StoredRecord } from "./stored-record.ts";
import type { Proposal } from "./write-validation.ts";

/** The fields whose values a before-write rule changes.
 * @param fields - Effective fields by ID.
 * @param before - The initial proposal.
 * @param after - The derived proposal.
 * @returns IDs whose stored values changed.
 */
export const hookChanges = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  before: ReadonlyMap<DefinitionId, DecodedInput>,
  after: ReadonlyMap<DefinitionId, DecodedInput>
): readonly DefinitionId[] =>
  [...after].flatMap(([fieldId, value]) => {
    const field = fields.get(fieldId);
    const previous = before.get(fieldId);

    const same =
      field !== undefined &&
      previous !== undefined &&
      storedEquals(field.type.kind, previous, value);

    return same ? [] : [fieldId];
  });

/** The written fields under the masking rule (Contracts 3.9).
 * @param fields - Effective fields by ID.
 * @param proposal - Proposed values and conversion errors.
 * @param existing - The stored record.
 * @param readable - Fields readable on the stored image.
 * @returns Changed, unreadable or invalid fields.
 */
export const writtenFields = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  proposal: Proposal,
  existing: StoredRecord,
  readable: ReadonlySet<DefinitionId>
): Set<DefinitionId> =>
  new Set(
    [...proposal.values.keys(), ...proposal.invalid.keys()].filter(
      (fieldId) => {
        const field = fields.get(fieldId);
        const value = proposal.values.get(fieldId);
        const before: StoredValue | null = existing.values.get(fieldId) ?? null;

        const unreadableOrInvalid =
          !readable.has(fieldId) || proposal.invalid.has(fieldId);

        const changed =
          field === undefined ||
          value === undefined ||
          !storedEquals(field.type.kind, before, value);

        return unreadableOrInvalid || changed;
      }
    )
  );
