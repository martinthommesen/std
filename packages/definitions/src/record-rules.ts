/**
 * The per-field write rules both sides of a form apply (Contracts 2.5, 3.8,
 * 6.3, 6.5, 6.7): the server's save pipeline runs them on full definitions,
 * the browser's `recordSchema` on the filtered metadata, so the two give the
 * same verdict for every field both see.
 *
 * A field's rules (`FieldRules`) are what validation reads of its effective
 * definition: type with overridden settings, required, read-only (an
 * auto-numbered field is read-only), state, constant default and, for a
 * choice field, its choices restricted to the class's effective subset.
 *
 * - `convertCreate` and `convertUpdate` convert a payload value under the
 *   type (`@std/values`) and check a choice key against the choice list:
 *   an active key is accepted, a retired (hidden) key only when it is the
 *   value already stored, and a key outside the class's subset is unknown.
 * - `fieldErrorsOf` gives the other field errors in a fixed order:
 *   `DefinitionRetired`, else `ReadOnlyField`, when the field is written;
 *   `Required` when the candidate is empty and the field required and
 *   active. An auto-numbered field is never `Required`: the record service
 *   assigns it.
 */
import { checkChoiceWrite } from "@std/values/choice";
import type { ChoiceList } from "@std/values/choice";
import { decodeIn, encodeOut } from "@std/values/codec";
import { storedEquals } from "@std/values/compare";
import type { StoredOrPlaintext } from "@std/values/compare";
import { isDecimal } from "@std/values/decimal";
import { refuse } from "@std/values/field-error";
import type { Decoded } from "@std/values/field-error";
import { isOwnerReferenceType } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import {
  isBigint,
  isBoolean,
  isNumber,
  isString,
} from "@std/values/field-value";
import type { DecodedInput } from "@std/values/field-value";
import { isJsonValue } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { planCreate, planUpdate } from "@std/values/write";
import { isPlaintext } from "@std/values/write-only";

import { effectiveChoices } from "./effective-schema.ts";
import type { EffectiveField } from "./effective-schema.ts";
import type { FieldError } from "./field-errors.ts";
import type { DefinitionId } from "./ids.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** What validation reads of one field as it applies to a class. */
export interface FieldRules {
  readonly id: DefinitionId;
  /** The field's API name. */
  readonly name: string;
  /** The type with overridden max length and bounds. */
  readonly type: FieldType;
  readonly required: boolean;
  /** Read-only, auto-numbered fields included. */
  readonly readOnly: boolean;
  /** Whether the record service assigns the value on create. */
  readonly autoNumber: boolean;
  readonly state: "active" | "retired";
  /** The constant default in canonical JSON, or null. */
  readonly default: JsonValue | null;
  /** A choice field's choices for the class; null for other kinds. */
  readonly choices: ChoiceList | null;
}

/** A choice as the choice list needs it. */
export interface ChoiceState {
  readonly key: string;
  /** A hidden choice is retired: kept when unchanged, refused when new. */
  readonly hidden: boolean;
}

/**
 * The choice list of a field: hidden choices are retired.
 *
 * @param choices - The field's choices for the class.
 * @returns Active and retired keys.
 */
export const choiceListOf = (choices: readonly ChoiceState[]): ChoiceList => ({
  active: new Set(
    choices.flatMap((choice) => (choice.hidden ? [] : [choice.key]))
  ),
  retired: new Set(
    choices.flatMap((choice) => (choice.hidden ? [choice.key] : []))
  ),
});

/**
 * The rules of one field for records of a class, from full definitions.
 *
 * @param snapshot - The configuration.
 * @param effective - The field as it applies to the class.
 * @returns Its rules.
 */
export const fieldRulesOf = (
  snapshot: ConfigSnapshot,
  effective: EffectiveField
): FieldRules => ({
  autoNumber: effective.numberPrefix !== null,
  choices:
    effective.type.kind === "choice"
      ? choiceListOf(effectiveChoices(snapshot, effective))
      : null,
  default: effective.default,
  id: effective.field.id,
  name: effective.field.name,
  readOnly: effective.readOnly,
  required: effective.required,
  state: effective.state,
  type: effective.type,
});

/**
 * A field's rules on an update: an owner reference is read-only after
 * create (Contracts 4.9), so a part never changes owner; writing a
 * different owner is `ReadOnlyField`.
 *
 * @param rules - The field's rules.
 * @returns The rules an update applies.
 */
export const rulesOnUpdate = (rules: FieldRules): FieldRules =>
  isOwnerReferenceType(rules.type) ? { ...rules, readOnly: true } : rules;

/**
 * The constant default of a field as an input value.
 *
 * @param rules - The field's rules.
 * @returns The converted default, or undefined when it has none.
 */
export const defaultInput = (rules: FieldRules): DecodedInput | undefined => {
  if (rules.default === null) {
    return undefined;
  }

  const converted = decodeIn(rules.type, rules.default);

  if (!converted.ok) {
    // Defaults are validated against the effective type when they are
    // defined (`validate.ts`), so this is a defect.
    throw new TypeError(`The default of field ${rules.id} is invalid`);
  }

  return converted.value;
};

/**
 * What a create stores for a field the body does not name: its default,
 * otherwise its empty value (false for boolean). An auto-numbered field is
 * empty here; the record service assigns its number.
 *
 * @param rules - The field's rules.
 * @returns The value.
 */
export const absentCreateValue = (rules: FieldRules): DecodedInput => {
  if (rules.autoNumber) {
    return null;
  }

  const planned = planCreate(
    rules.type,
    { present: false },
    defaultInput(rules)
  );

  return planned.ok && planned.value.action === "set"
    ? planned.value.value
    : null;
};

const storedKey = (stored: StoredOrPlaintext | undefined): string | null =>
  isString(stored) ? stored : null;

/**
 * Checks a converted value against the field's choices.
 *
 * @param rules - The field's rules.
 * @param value - The converted value.
 * @param stored - The value stored before the write, or null on create.
 * @returns The value, or `unknownChoice` or `retiredChoice`.
 */
const checkChoice = (
  rules: FieldRules,
  value: DecodedInput,
  stored: StoredOrPlaintext | undefined
): Decoded<DecodedInput> => {
  if (rules.choices === null || !isString(value)) {
    return { ok: true, value };
  }

  return checkChoiceWrite(value, rules.choices, storedKey(stored));
};

/**
 * Converts a create's payload value under the field's rules.
 *
 * @param rules - The field's rules.
 * @param json - The payload value (present; `null` clears).
 * @returns The input value, or the refusal.
 */
export const convertCreate = (
  rules: FieldRules,
  json: JsonValue
): Decoded<DecodedInput> => {
  const planned = planCreate(rules.type, { json, present: true });

  if (!planned.ok) {
    return planned;
  }

  return planned.value.action === "set"
    ? checkChoice(rules, planned.value.value, null)
    : { ok: true, value: null };
};

/**
 * Converts an update's payload value under the field's rules. An
 * unchanged retired choice key is kept (Contracts 6.5).
 *
 * @param rules - The field's rules.
 * @param json - The payload value (present; `null` clears).
 * @param stored - The value stored before the update.
 * @returns The input value, or the refusal.
 */
export const convertUpdate = (
  rules: FieldRules,
  json: JsonValue,
  stored: StoredOrPlaintext | undefined
): Decoded<DecodedInput> => {
  const planned = planUpdate(rules.type, { json, present: true });

  if (!planned.ok) {
    return planned;
  }

  return planned.value.action === "set"
    ? checkChoice(rules, planned.value.value, stored)
    : { ok: true, value: null };
};

const notOfType = refuse(
  "wrongJsonType",
  "The value is not of this field's type."
);

/**
 * Whether a value has the shape `decodeIn` gives for a kind.
 *
 * @param type - The field type.
 * @param value - A non-null input value.
 * @returns True when the value belongs to the kind.
 */
const isInputOfType = (type: FieldType, value: DecodedInput): boolean => {
  switch (type.kind) {
    case "text":
    case "longText":
    case "date":
    case "choice":
    case "reference":
    case "uuid": {
      return isString(value);
    }

    case "integer":
    case "dateTime": {
      return isNumber(value);
    }

    case "bigInteger": {
      return isBigint(value);
    }

    case "decimal": {
      return isDecimal(value);
    }

    case "boolean": {
      return isBoolean(value);
    }

    case "password":
    case "secret": {
      return isPlaintext(value);
    }

    case "json":
    case "condition": {
      return isJsonValue(value);
    }

    default: {
      return type satisfies never;
    }
  }
};

/**
 * Rechecks one final value under the field's rules: a value a hook
 * proposed must meet the same type, length, bound and choice rules as one
 * from the body. The value goes through its canonical JSON and back, which
 * also normalizes it (text conversion, decimal scale).
 *
 * @param rules - The field's rules.
 * @param value - The final input value.
 * @param stored - The value stored before the write; null on create.
 * @returns The normalized value, or the refusal.
 */
export const recheckValue = (
  rules: FieldRules,
  value: DecodedInput,
  stored: StoredOrPlaintext | undefined
): Decoded<DecodedInput> => {
  const { type } = rules;

  if (value === null) {
    return decodeIn(type, null);
  }

  if (!isInputOfType(type, value)) {
    return notOfType;
  }

  // Plaintext is checked like body input (non-empty, well-formed, no
  // U+0000); refusals never carry the value.
  if (isPlaintext(value)) {
    return decodeIn(type, value.reveal());
  }

  const decoded = decodeIn(type, encodeOut(type, value));

  return decoded.ok ? checkChoice(rules, decoded.value, stored) : decoded;
};

/**
 * Whether a value a create supplies counts as written: a retired field, or
 * a value that differs from what the create stores without it (a read-only
 * field set to its default is not written; an auto-numbered field is
 * written by any value but null).
 *
 * @param rules - The field's rules.
 * @param value - The supplied value, converted.
 * @returns True when written.
 */
export const writtenOnCreate = (
  rules: FieldRules,
  value: DecodedInput
): boolean =>
  rules.state !== "active" ||
  !storedEquals(rules.type.kind, absentCreateValue(rules), value);

/**
 * The field errors of one field other than `InvalidValue`, in order:
 * `DefinitionRetired` (else `ReadOnlyField`) when written, `Required` when
 * the candidate is empty and the field required and active.
 *
 * @param rules - The field's rules.
 * @param candidate - The value the record would store; undefined when
 *   unknown.
 * @param written - Whether the write changes the field (Contracts 3.9).
 * @returns The errors.
 */
export const fieldErrorsOf = (
  rules: FieldRules,
  candidate: StoredOrPlaintext | undefined,
  written: boolean
): readonly FieldError[] => {
  const errors: FieldError[] = [];

  if (written && rules.state !== "active") {
    errors.push({ _tag: "DefinitionRetired", field: rules.name });
  } else if (written && rules.readOnly) {
    errors.push({ _tag: "ReadOnlyField", field: rules.name });
  }

  const empty = candidate === null || candidate === undefined;

  if (
    empty &&
    rules.required &&
    !rules.autoNumber &&
    rules.state === "active"
  ) {
    errors.push({ _tag: "Required", field: rules.name });
  }

  return errors;
};
