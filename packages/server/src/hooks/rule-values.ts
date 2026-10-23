/**
 * The values record-rule actions set (Contracts 4.10):
 *
 * - `{ value }`: the literal, converted under the field's type;
 * - `{ ctx: "now" }`: the evaluation instant (date-time fields);
 *   `{ ctx: "me" }`: the acting user's ID;
 * - `{ copy }`: the value of a field of the rule's record or of the
 *   current `forEach` record, as stored (definition validation keeps the
 *   kinds equal; the save validates the value against the target field);
 * - `{ increment }`: the rule's record's integer field plus 1, 1 when it
 *   is empty.
 *
 * A value the definition checks should have refused is a defect.
 */
import type { RecordImage } from "@std/conditions/evaluate-core";
import type { RuleAssignment } from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { decodeIn, encodeOut } from "@std/values/codec";
import { formatDateTime } from "@std/values/date-time";
import type { FieldType } from "@std/values/field-type";
import { isBigint, isNumber, isString } from "@std/values/field-value";
import type { DecodedInput } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import { isPlaintext, isSecretState } from "@std/values/write-only";

/** A record a value reads: its ID (null before a create) and image. */
export interface ValueRecord {
  readonly id: string | null;
  readonly image: RecordImage;
}

/** Where values come from. */
export interface ValueSources {
  /** The rule's record (for `before` rules, as proposed so far). */
  readonly record: ValueRecord;
  /** The current `forEach` record, when the action has one. */
  readonly source: ValueRecord | null;
  /**
   * The owner, while settling (aggregate rules, 4.9): the rule's record
   * itself, so `owner.f` and `record.f` read the same image. Absent
   * outside settling.
   */
  readonly owner?: ValueRecord;
  /** The acting user. */
  readonly me: string;
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
}

const defect = (message: string): never => {
  throw new RangeError(`Record rule value: ${message}`);
};

const LINE_BREAK = /[\r\n\u2028\u2029]/u;

const copiedValue = (
  value: DecodedInput,
  limit: number | undefined
): DecodedInput => {
  if (limit === undefined || value === null) {
    return value;
  }

  if (!isString(value)) {
    return defect("a first-line copy read a non-text field");
  }

  const characters: string[] = [];

  for (const character of value) {
    if (LINE_BREAK.test(character) || characters.length === limit) {
      break;
    }

    characters.push(character);
  }

  return characters.join("");
};

const converted = (type: FieldType, json: JsonValue): DecodedInput => {
  const result = decodeIn(type, json);

  return result.ok ? result.value : defect("a value does not convert");
};

const read = (
  record: ValueRecord | null,
  fieldId: string | null
): DecodedInput => {
  if (fieldId === null) {
    return record?.id ?? defect("a record without an ID was copied");
  }

  const value = record?.image[fieldId];

  if (value === undefined) {
    return defect(`field ${fieldId} is missing from its image`);
  }

  return isPlaintext(value) || isSecretState(value)
    ? defect("a write-only value was read")
    : value;
};

// The source's value plus 1, or 1 when it is empty. Definition validation
// keeps source and target the same kind; anything else is a defect, never
// silently 1.
const incremented = (type: FieldType, value: DecodedInput): DecodedInput => {
  if (value === null) {
    return type.kind === "bigInteger" ? 1n : 1;
  }

  if (type.kind === "bigInteger" && isBigint(value)) {
    return value + 1n;
  }

  return type.kind === "integer" && isNumber(value)
    ? value + 1
    : defect("an increment's source is not of its field's kind");
};

/**
 * The value one assignment gives its field.
 *
 * @param assignment - The field and its value form.
 * @param type - The target field's type.
 * @param sources - The record, the `forEach` record, `me` and `now`.
 * @returns The input value.
 */
const ruleValue = (
  assignment: RuleAssignment,
  type: FieldType,
  sources: ValueSources
): DecodedInput => {
  const { value } = assignment;

  if ("value" in value) {
    return converted(type, value.value);
  }

  if ("ctx" in value) {
    return value.ctx === "now"
      ? converted(type, formatDateTime(sources.now))
      : converted(type, sources.me);
  }

  if ("copy" in value) {
    const { from, fieldId } = value.copy;

    if (from === "owner") {
      return sources.owner === undefined
        ? defect("owner values are read only while settling (4.9)")
        : copiedValue(read(sources.owner, fieldId), value.copy.firstLine);
    }

    return copiedValue(
      read(from === "record" ? sources.record : sources.source, fieldId),
      value.copy.firstLine
    );
  }

  return incremented(type, read(sources.record, value.increment));
};

/**
 * Resolve an assigned field and its value under the current configuration.
 * @param snapshot - The configuration owning the assigned field.
 * @param assignment - The field and value form.
 * @param sources - The records and evaluation context the value reads.
 * @returns The field and converted value; an unknown field is a definition defect.
 */
export const assignedValue = (
  snapshot: ConfigSnapshot,
  assignment: RuleAssignment,
  sources: ValueSources
) => {
  const field = snapshot.field(assignment.fieldId);

  if (field === undefined) {
    throw new RangeError(`Rule field ${assignment.fieldId} is unknown.`);
  }

  return { field, value: ruleValue(assignment, field.type, sources) };
};

/**
 * The canonical JSON of a value an action sets, for a nested save's body.
 *
 * @param type - The target field's type.
 * @param value - The input value.
 * @returns Canonical JSON (6.6).
 */
export const bodyValue = (type: FieldType, value: DecodedInput): JsonValue =>
  isPlaintext(value)
    ? defect("rules never set write-only values")
    : encodeOut(type, value);
