/**
 * Proposed values and their validation (Contracts 2.5, 3.8, 6.3, 6.5, 6.7).
 *
 * Values are converted under the rules of the record's concrete class
 * (`@std/definitions/record-rules`: the effective type with overridden max
 * length and bounds, the choices of the class's effective subset), so a
 * write through a parent endpoint is validated against the child's
 * overrides (2.2 item 5). The browser's `recordSchema` applies the same
 * rules to the metadata, so both give the same verdict per field (6.3).
 * Validation then lists every field error together (6.7):
 *
 * - `InvalidValue`: the value does not convert (type, max length, bounds,
 *   choices).
 * - `Required`: a required field (with stacked overrides) would be empty.
 *   Text `""` and whitespace convert to null first.
 * - `ReadOnlyField`: a read-only (or auto-numbered) field is written.
 * - `DefinitionRetired`: a retired field is written.
 *
 * On create, an absent field gets its constant default, otherwise its empty
 * value (false for boolean, null otherwise); an explicit `null` skips the
 * default. On update, an absent field is unchanged.
 *
 * Validation runs after before-write hooks (Contracts 4.1 step 6), on the
 * final candidate: `finalizeCreate` and `finalizeUpdate` recheck every
 * value, the hooks' included, under the field's rules, and
 * `validateProposal` checks required fields over the whole record.
 */
import { checkConditionJson } from "@std/conditions/check";
import type { ClassView } from "@std/conditions/class-view";
import type { ConditionIssue } from "@std/conditions/issue";
import { invalidValue } from "@std/definitions/field-errors";
import type { FieldError } from "@std/definitions/field-errors";
import type { DefinitionId } from "@std/definitions/ids";
import {
  absentCreateValue,
  convertCreate,
  convertUpdate,
  fieldErrorsOf,
  recheckValue,
} from "@std/definitions/record-rules";
import type { FieldRules } from "@std/definitions/record-rules";
import { InvalidValue } from "@std/values/field-error";
import type { DecodedInput } from "@std/values/field-value";
import { isJsonValue } from "@std/values/json-value";

import type { StoredRecord } from "./stored-record.ts";
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

/** The rules of every field of the record's concrete class, by ID. */
export type RulesById = ReadonlyMap<DefinitionId, FieldRules>;

/**
 * Proposes the values of a create.
 *
 * @param rules - The rules of the class being created, by ID.
 * @param body - The resolved body.
 * @returns The proposal.
 */
export const proposeCreate = (rules: RulesById, body: WriteBody): Proposal => {
  const values = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map<DefinitionId, InvalidValue>();

  for (const [fieldId, field] of rules) {
    const entry = body.entries.get(fieldId);

    if (entry === undefined) {
      if (field.state === "active") {
        values.set(fieldId, absentCreateValue(field));
      }
    } else {
      const converted = convertCreate(field, entry.json);

      if (converted.ok) {
        values.set(fieldId, converted.value);
      } else {
        invalid.set(fieldId, converted.error);
      }
    }
  }

  return { invalid, values };
};

const rulesOf = (rules: RulesById, fieldId: DefinitionId): FieldRules => {
  const found = rules.get(fieldId);

  if (found === undefined) {
    // The nameable fields of an endpoint are fields of its lineage, which
    // the concrete class inherits; hooks only name fields of the record.
    throw new RangeError(`Field ${fieldId} is not a field of the record`);
  }

  return found;
};

/**
 * Proposes the values of an update: the body's fields only.
 *
 * @param rules - The rules of the record's concrete class, by ID.
 * @param body - The resolved body.
 * @param existing - The stored record (an unchanged retired choice is kept).
 * @returns The proposal.
 */
export const proposeUpdate = (
  rules: RulesById,
  body: WriteBody,
  existing: StoredRecord
): Proposal => {
  const values = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map<DefinitionId, InvalidValue>();

  for (const [fieldId, entry] of body.entries) {
    const converted = convertUpdate(
      rulesOf(rules, fieldId),
      entry.json,
      existing.values.get(fieldId)
    );

    if (converted.ok) {
      values.set(fieldId, converted.value);
    } else {
      invalid.set(fieldId, converted.error);
    }
  }

  return { invalid, values };
};

const recheckAll = (
  rules: RulesById,
  proposal: Proposal,
  values: Iterable<readonly [DefinitionId, DecodedInput]>,
  existing: StoredRecord | null
): Proposal => {
  const checked = new Map<DefinitionId, DecodedInput>();
  const invalid = new Map(proposal.invalid);

  for (const [fieldId, value] of values) {
    const rechecked = recheckValue(
      rulesOf(rules, fieldId),
      value,
      existing?.values.get(fieldId) ?? null
    );

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
 * without it), and every value is rechecked under its rules.
 *
 * @param rules - The rules of the class, by ID.
 * @param proposal - The body's refusals and the hooks' values.
 * @returns The final proposal.
 */
export const finalizeCreate = (
  rules: RulesById,
  proposal: Proposal
): Proposal => {
  const complete = new Map(proposal.values);

  for (const [fieldId, field] of rules) {
    if (field.state === "active" && !complete.has(fieldId)) {
      complete.set(fieldId, absentCreateValue(field));
    }
  }

  return recheckAll(rules, proposal, complete, null);
};

/**
 * The final candidate of an update, after before-write hooks: every value
 * the update sets, rechecked under its rules. Fields it does not set keep
 * their stored values.
 *
 * @param rules - The rules of the class, by ID.
 * @param proposal - The body's refusals and the hooks' values.
 * @param existing - The stored record.
 * @returns The final proposal.
 */
export const finalizeUpdate = (
  rules: RulesById,
  proposal: Proposal,
  existing: StoredRecord
): Proposal => recheckAll(rules, proposal, proposal.values, existing);

const invalidCondition = (issues: readonly ConditionIssue[]): InvalidValue =>
  new InvalidValue({
    hint: issues
      .map((issue) => `${issue.reason} at ${issue.path.join(".") || "root"}`)
      .join("; "),
    message:
      "The condition does not check against this field's table and profile.",
    reason: "invalidCondition",
  });

/**
 * Checks every condition value a write sets (Contracts 5.2, 6.5): a
 * non-null value of a written condition field is checked as being stored
 * against the field's class and profile, in the caller's view. Field IDs
 * must exist there and not be retired, operators must fit the type and
 * profile, literals must convert.
 *
 * The view is the caller's (the filter profile reads the caller's readable
 * fields, 3.4, 5.10), so a field the caller can never read is unknown,
 * exactly like an ID that names nothing; the hint lists only issue reasons
 * and AST positions, never a field (decision 0005, "Condition fields").
 * Only written fields are checked: a stored condition that a later retire
 * made invalid stays as it is until the field itself is written again.
 * This check is server-only (Contracts 6.3): it needs the caller's view of
 * another table.
 *
 * @param rules - The rules of the record's class, by ID.
 * @param values - The final proposed values.
 * @param written - The fields the write changes (Contracts 3.9).
 * @param view - What the caller may name in a condition.
 * @returns The refusals, by field ID.
 */
export const conditionRefusals = (
  rules: RulesById,
  values: ReadonlyMap<DefinitionId, DecodedInput>,
  written: ReadonlySet<DefinitionId>,
  view: ClassView
): ReadonlyMap<DefinitionId, InvalidValue> => {
  const refusals = new Map<DefinitionId, InvalidValue>();

  for (const fieldId of written) {
    const type = rules.get(fieldId)?.type;
    const value = values.get(fieldId);

    if (
      type?.kind === "condition" &&
      value !== undefined &&
      value !== null &&
      isJsonValue(value)
    ) {
      const checked = checkConditionJson(value, {
        classId: type.classId,
        profile: type.profile,
        purpose: "store",
        view,
      });

      if (!checked.ok) {
        refusals.set(fieldId, invalidCondition(checked.error.issues));
      }
    }
  }

  return refusals;
};

/** What validation needs besides the proposal. */
export interface ValidationInput {
  /** The rules of the record's concrete class, by ID. */
  readonly rules: RulesById;
  /** The final proposal (see `finalizeCreate`, `finalizeUpdate`). */
  readonly proposal: Proposal;
  /** The fields the write changes (Contracts 3.9). */
  readonly written: ReadonlySet<DefinitionId>;
  /**
   * Written fields that only before-write hooks set (record rules,
   * 4.10): system-written, so `ReadOnlyField` and `DefinitionRetired` do
   * not apply to them; their values are still checked.
   */
  readonly hookOnly?: ReadonlySet<DefinitionId>;
  /** The stored record an update starts from; null for a create. */
  readonly existing: StoredRecord | null;
}

/**
 * Validates the complete final candidate against the rules of the
 * record's concrete class: refused values, written read-only and retired
 * fields, and every required field (with stacked overrides) of the record
 * as it would be stored.
 *
 * @param input - Rules, final proposal, written fields, existing record.
 * @returns Every field error, in field order; empty when valid.
 */
export const validateProposal = (
  input: ValidationInput
): readonly FieldError[] => {
  const errors: FieldError[] = [];

  for (const [fieldId, field] of input.rules) {
    const refused = input.proposal.invalid.get(fieldId);

    if (refused === undefined) {
      const candidate = input.proposal.values.has(fieldId)
        ? input.proposal.values.get(fieldId)
        : input.existing?.values.get(fieldId);

      const written =
        input.written.has(fieldId) && input.hookOnly?.has(fieldId) !== true;

      errors.push(...fieldErrorsOf(field, candidate, written));
    } else {
      errors.push(invalidValue(field.name, refused));
    }
  }

  return errors;
};
