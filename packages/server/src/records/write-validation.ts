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
 */
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { decodeIn } from "@std/values/codec";
import type { InvalidValue } from "@std/values/field-error";
import type { DecodedInput } from "@std/values/field-value";
import { planCreate, planUpdate } from "@std/values/write";
import type { PayloadEntry } from "@std/values/write";

import { invalidValue } from "./field-errors.ts";
import type { FieldError } from "./field-errors.ts";
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

/** What validation needs besides the proposal. */
export interface ValidationInput {
  /** The effective fields of the record's concrete class, by ID. */
  readonly fields: ReadonlyMap<DefinitionId, EffectiveField>;
  readonly proposal: Proposal;
  /** The fields the write changes (Contracts 3.9). */
  readonly written: ReadonlySet<DefinitionId>;
}

const fieldErrorsOf = (
  field: EffectiveField,
  value: DecodedInput,
  written: boolean
): readonly FieldError[] => {
  const { name } = field.field;
  const errors: FieldError[] = [];

  if (written && field.field.state !== "active") {
    errors.push({ _tag: "DefinitionRetired", field: name });
  } else if (written && field.readOnly) {
    errors.push({ _tag: "ReadOnlyField", field: name });
  }

  if (value === null && field.required && field.field.state === "active") {
    errors.push({ _tag: "Required", field: name });
  }

  return errors;
};

/**
 * Validates a proposal against the effective schema of the record's
 * concrete class.
 *
 * @param input - Fields, proposal and written fields.
 * @returns Every field error, in field order; empty when valid.
 */
export const validateProposal = (
  input: ValidationInput
): readonly FieldError[] => {
  const errors: FieldError[] = [];

  for (const [fieldId, field] of input.fields) {
    const refused = input.proposal.invalid.get(fieldId);

    if (refused === undefined) {
      const value = input.proposal.values.get(fieldId);

      if (value !== undefined) {
        errors.push(...fieldErrorsOf(field, value, input.written.has(fieldId)));
      }
    } else {
      errors.push(invalidValue(field.field.name, refused));
    }
  }

  return errors;
};
