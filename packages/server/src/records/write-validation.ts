import { invalidValue } from "@std/api/errors/field-errors";
import type { FieldError } from "@std/api/errors/field-errors";
/**
 * Proposed values and their validation (Contracts 2.5, 3.8, 6.5, 6.7).
 *
 * Values are converted with `@std/values` under the effective type of the
 * record's concrete class (overridden max length and bounds included), so
 * a write through a parent endpoint is validated against the child's
 * overrides (2.2 item 5). Validation then lists every field error
 * together (6.7):
 *
 * - `InvalidValue`: the value does not convert (type, max length, bounds).
 * - `Required`: a required field (with stacked overrides) would be empty.
 *   Text `""` and whitespace convert to null first.
 * - `ReadOnlyField`: a read-only field is written.
 * - `DefinitionRetired`: a retired field is written.
 *
 * On create, an absent field gets its constant default, otherwise its empty
 * value (false for boolean, null otherwise); an explicit `null` skips the
 * default. On update, an absent field is unchanged.
 *
 * Validation runs after before-write hooks (Contracts 4.1 step 6), on the
 * final candidate: `finalizeCreate` and `finalizeUpdate` recheck every
 * value, the hooks' included, under the effective type, and
 * `validateProposal` checks required fields over the whole record.
 */
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { decodeIn, encodeOut } from "@std/values/codec";
import type { StoredOrPlaintext } from "@std/values/compare";
import { refuse } from "@std/values/field-error";
import type { Decoded, InvalidValue } from "@std/values/field-error";
import type { DecodedInput } from "@std/values/field-value";
import { planCreate, planUpdate } from "@std/values/write";
import type { PayloadEntry } from "@std/values/write";
import { isPlaintext } from "@std/values/write-only";

import type { StoredRecord } from "./stored-record.ts";
import { isInputOfKind } from "./stored-values.ts";
import type { WriteBody } from "./write-body.ts";

/** The values a write proposes, before validation. */
export interface Proposal {
  /**
   * The proposed value of every field the write sets, by field ID: on
   * create every live, non-retired field of the class (plus supplied
   * retired ones), on update the body's fields.
   */
  readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
  /** Fields whose body value did not convert, with the refusal. */
  readonly invalid: ReadonlyMap<DefinitionId, InvalidValue>;
}

const absent: PayloadEntry = { present: false };

/**
 * The constant default of a field as an input value.
 *
 * @param field - The effective field.
 * @returns The converted default, or undefined when it has none.
 */
export const defaultInput = (
  field: EffectiveField
): DecodedInput | undefined => {
  if (field.default === null) {
    return undefined;
  }

  const converted = decodeIn(field.type, field.default);

  if (!converted.ok) {
    // Defaults are validated against the effective type when they are
    // defined (`@std/definitions/validate`), so this is a defect.
    throw new TypeError(`The default of field ${field.field.id} is invalid`);
  }

  return converted.value;
};

/**
 * What a create stores for a field the body does not name.
 *
 * @param field - The effective field.
 * @returns The default, or the empty value.
 */
export const absentCreateValue = (field: EffectiveField): DecodedInput => {
  const planned = planCreate(field.type, absent, defaultInput(field));

  return planned.ok && planned.value.action === "set"
    ? planned.value.value
    : null;
};

/**
 * Proposes the values of a create.
 *
 * @param fields - The effective fields of the class being created.
 * @param body - The resolved body.
 * @returns The proposal.
 */
export const proposeCreate = (
  fields: readonly EffectiveField[],
  body: WriteBody
): Proposal => {
  const values = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map<DefinitionId, InvalidValue>();

  for (const field of fields) {
    const fieldId = field.field.id;
    const entry = body.entries.get(fieldId);

    if (entry === undefined) {
      if (field.field.state === "active") {
        values.set(fieldId, absentCreateValue(field));
      }
    } else {
      const planned = planCreate(
        field.type,
        { json: entry.json, present: true },
        defaultInput(field)
      );

      if (!planned.ok) {
        invalid.set(fieldId, planned.error);
      } else if (planned.value.action === "set") {
        values.set(fieldId, planned.value.value);
      }
    }
  }

  return { invalid, values };
};

/**
 * Proposes the values of an update: the body's fields only.
 *
 * @param fields - The effective fields of the record's concrete class.
 * @param body - The resolved body.
 * @returns The proposal.
 */
export const proposeUpdate = (
  fields: readonly EffectiveField[],
  body: WriteBody
): Proposal => {
  const values = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map<DefinitionId, InvalidValue>();
  const byId = new Map(fields.map((field) => [field.field.id, field]));

  for (const [fieldId, entry] of body.entries) {
    const field = byId.get(fieldId);

    if (field === undefined) {
      // The nameable fields of an endpoint are fields of its lineage, which
      // the concrete class inherits.
      throw new RangeError(`Field ${fieldId} is not a field of the record`);
    }

    const planned = planUpdate(field.type, { json: entry.json, present: true });

    if (!planned.ok) {
      invalid.set(fieldId, planned.error);
    } else if (planned.value.action === "set") {
      values.set(fieldId, planned.value.value);
    }
  }

  return { invalid, values };
};

const notOfType = refuse(
  "wrongJsonType",
  "The value is not of this field's type."
);

/**
 * Rechecks one final value under the field's effective type: the value a
 * hook proposed must meet the same type, length and bound rules as one
 * from the body. The value goes through its canonical JSON and back, which
 * also normalizes it (text conversion, decimal scale).
 *
 * @param field - The effective field.
 * @param value - The final input value.
 * @returns The normalized value, or the refusal.
 */
export const recheckValue = (
  field: EffectiveField,
  value: DecodedInput
): Decoded<DecodedInput> => {
  const { type } = field;

  if (value === null) {
    return decodeIn(type, null);
  }

  if (!isInputOfKind(type.kind, value)) {
    return notOfType;
  }

  // Plaintext is checked like body input (non-empty, well-formed, no
  // U+0000); refusals never carry the value.
  return isPlaintext(value)
    ? decodeIn(type, value.reveal())
    : decodeIn(type, encodeOut(type, value));
};

const recheckAll = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  proposal: Proposal,
  values: Iterable<readonly [DefinitionId, DecodedInput]>
): Proposal => {
  const checked = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map(proposal.invalid);

  for (const [fieldId, value] of values) {
    const field = fields.get(fieldId);

    if (field === undefined) {
      // Hooks and bodies only name fields of the record's class.
      throw new RangeError(`Field ${fieldId} is not a field of the record`);
    }

    const rechecked = recheckValue(field, value);

    if (!invalid.has(fieldId)) {
      if (rechecked.ok) {
        checked.set(fieldId, rechecked.value);
      } else {
        invalid.set(fieldId, rechecked.error);
      }
    }
  }

  return { invalid, values: checked };
};

/**
 * The final candidate of a create, after before-write hooks: every live
 * field has a value (a field the hooks dropped gets what a create stores
 * without it), and every value is rechecked under its effective type.
 *
 * @param fields - The effective fields of the class, by ID.
 * @param proposal - The body's refusals and the hooks' values.
 * @returns The final proposal.
 */
export const finalizeCreate = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  proposal: Proposal
): Proposal => {
  const complete = new Map(proposal.values);

  for (const [fieldId, field] of fields) {
    if (field.field.state === "active" && !complete.has(fieldId)) {
      complete.set(fieldId, absentCreateValue(field));
    }
  }

  return recheckAll(fields, proposal, complete);
};

/**
 * The final candidate of an update, after before-write hooks: every value
 * the update sets, rechecked under its effective type. Fields it does not
 * set keep their stored values.
 *
 * @param fields - The effective fields of the class, by ID.
 * @param proposal - The body's refusals and the hooks' values.
 * @returns The final proposal.
 */
export const finalizeUpdate = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  proposal: Proposal
): Proposal => recheckAll(fields, proposal, proposal.values);

/** What validation needs besides the proposal. */
export interface ValidationInput {
  /** The effective fields of the record's concrete class, by ID. */
  readonly fields: ReadonlyMap<DefinitionId, EffectiveField>;
  /** The final proposal (see `finalizeCreate`, `finalizeUpdate`). */
  readonly proposal: Proposal;
  /** The fields the write changes (Contracts 3.9). */
  readonly written: ReadonlySet<DefinitionId>;
  /** The stored record an update starts from; null for a create. */
  readonly existing: StoredRecord | null;
}

const fieldErrorsOf = (
  field: EffectiveField,
  candidate: StoredOrPlaintext | undefined,
  written: boolean
): readonly FieldError[] => {
  const { name } = field.field;
  const errors: FieldError[] = [];

  if (written && field.field.state !== "active") {
    errors.push({ _tag: "DefinitionRetired", field: name });
  } else if (written && field.readOnly) {
    errors.push({ _tag: "ReadOnlyField", field: name });
  }

  const empty = candidate === null || candidate === undefined;

  if (empty && field.required && field.field.state === "active") {
    errors.push({ _tag: "Required", field: name });
  }

  return errors;
};

/**
 * Validates the complete final candidate against the effective schema of
 * the record's concrete class: refused values, written read-only and
 * retired fields, and every required field (with stacked overrides) of
 * the record as it would be stored.
 *
 * @param input - Fields, final proposal, written fields, existing record.
 * @returns Every field error, in field order; empty when valid.
 */
export const validateProposal = (
  input: ValidationInput
): readonly FieldError[] => {
  const errors: FieldError[] = [];

  for (const [fieldId, field] of input.fields) {
    const refused = input.proposal.invalid.get(fieldId);

    if (refused === undefined) {
      const candidate = input.proposal.values.has(fieldId)
        ? input.proposal.values.get(fieldId)
        : input.existing?.values.get(fieldId);

      errors.push(
        ...fieldErrorsOf(field, candidate, input.written.has(fieldId))
      );
    } else {
      errors.push(invalidValue(field.field.name, refused));
    }
  }

  return errors;
};
