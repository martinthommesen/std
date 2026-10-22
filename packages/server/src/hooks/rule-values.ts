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
import { decodeIn, encodeOut } from "@std/values/codec";
import type { FieldType } from "@std/values/field-type";
import { isBigint, isNumber } from "@std/values/field-value";
import type { DecodedInput } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import { isPlaintext, isSecretState } from "@std/values/write-only";

/** Where values come from. */
export interface ValueSources {
  /** The rule's record (for `before` rules, as proposed so far). */
  readonly record: RecordImage;
  /** The current `forEach` record, when the action has one. */
  readonly source: RecordImage | null;
  /** The acting user. */
  readonly me: string;
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
}

const defect = (message: string): never => {
  throw new RangeError(`Record rule value: ${message}`);
};

const converted = (type: FieldType, json: JsonValue): DecodedInput => {
  const result = decodeIn(type, json);

  return result.ok ? result.value : defect("a value does not convert");
};

const read = (image: RecordImage | null, fieldId: string): DecodedInput => {
  const value = image?.[fieldId];

  if (value === undefined) {
    return defect(`field ${fieldId} is missing from its image`);
  }

  return isPlaintext(value) || isSecretState(value)
    ? defect("a write-only value was read")
    : value;
};

const incremented = (type: FieldType, value: DecodedInput): DecodedInput => {
  if (type.kind === "bigInteger") {
    return isBigint(value) ? value + 1n : 1n;
  }

  return isNumber(value) ? value + 1 : 1;
};

/**
 * The value one assignment gives its field.
 *
 * @param assignment - The field and its value form.
 * @param type - The target field's type.
 * @param sources - The record, the `forEach` record, `me` and `now`.
 * @returns The input value.
 */
export const ruleValue = (
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
      ? converted(type, new Date(sources.now).toISOString())
      : converted(type, sources.me);
  }

  if ("copy" in value) {
    const { from, fieldId } = value.copy;

    if (from === "owner") {
      return defect("owner values are read only while settling (4.9)");
    }

    return read(from === "record" ? sources.record : sources.source, fieldId);
  }

  return incremented(type, read(sources.record, value.increment));
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
