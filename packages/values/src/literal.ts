/**
 * Condition literal conversion (Contracts 5.2): a literal converts under its
 * field type's rules, not the field's settings. So a decimal literal may
 * exceed the field's scale (at most 100 digits), an integer outside the
 * type's range is refused, text is limited by the type's limit rather than
 * the field's maximum length, and a retired but existing choice is allowed.
 *
 * Text literals for `eq` and `in` get the write conversion; one that converts
 * to null is refused with a hint to use `empty`. Needles for the pattern
 * operators get steps 1 and 2 only, and `contains` refuses an empty needle.
 */
import { checkChoiceLiteral, parseChoiceKey } from "./choice.ts";
import type { ChoiceList } from "./choice.ts";
import { parseDateTime } from "./date-time.ts";
import { parseDate } from "./date.ts";
import type { IsoDate } from "./date.ts";
import { parseDecimal, rescaleDecimal } from "./decimal.ts";
import type { Decimal } from "./decimal.ts";
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";
import type { FieldKind, FieldType, FieldTypeOf } from "./field-type.ts";
import {
  BIG_INTEGER_MAX,
  BIG_INTEGER_MIN,
  checkInteger,
  INTEGER_MAX,
  INTEGER_MIN,
  parseBigInteger,
} from "./integer.ts";
import { isJsonBoolean, isJsonNumber, isJsonString } from "./json-value.ts";
import type { JsonValue } from "./json-value.ts";
import type { PatternOperator } from "./like-pattern.ts";
import {
  checkLength,
  convertLongText,
  convertNeedle,
  convertSingleLineText,
  LONG_TEXT_MAX_LENGTH,
  TEXT_MAX_LENGTH_LIMIT,
} from "./text.ts";
import { parseUuid } from "./uuid.ts";
import type { Uuid } from "./uuid.ts";

/** The value of a converted literal: the stored value type of its kind. */
export type LiteralValue =
  | string
  | number
  | bigint
  | boolean
  | Decimal
  | IsoDate
  | Uuid;

/** Options for literal conversion. */
export interface LiteralOptions {
  /** The field's choices, to check choice literals exist (active or retired). */
  readonly choices?: ChoiceList;
}

/** Literal conversion needs the kind and text policy, but ignores field limits. */
export type LiteralType = Pick<FieldType, "kind"> &
  Pick<FieldTypeOf<"text">, "textPolicy">;

const typeLimit = (kind: "text" | "longText"): number =>
  kind === "text" ? TEXT_MAX_LENGTH_LIMIT : LONG_TEXT_MAX_LENGTH;

const wrongType = (expected: string): Decoded<never> =>
  refuse("wrongJsonType", `Expected ${expected}.`);

const convertTextLiteral = (
  kind: "text" | "longText",
  json: JsonValue,
  policy: FieldTypeOf<"text">["textPolicy"]
): Decoded<string> => {
  if (!isJsonString(json)) {
    return wrongType("a string");
  }

  const converted =
    kind === "text"
      ? convertSingleLineText(json, policy)
      : convertLongText(json, policy);

  if (!converted.ok) {
    return converted;
  }

  if (converted.value === null) {
    return refuse(
      "emptyLiteral",
      "This text converts to empty.",
      "Use the empty operator to match empty values."
    );
  }

  return checkLength(converted.value, typeLimit(kind));
};

const convertChoiceLiteral = (
  json: JsonValue,
  options: LiteralOptions
): Decoded<string> => {
  if (!isJsonString(json)) {
    return wrongType("a choice key");
  }

  const key = parseChoiceKey(json);

  return key.ok && options.choices !== undefined
    ? checkChoiceLiteral(key.value, options.choices)
    : key;
};

const stringLiteral = <A>(
  json: JsonValue,
  parse: (text: string) => Decoded<A>
): Decoded<A> => (isJsonString(json) ? parse(json) : wrongType("a string"));

/**
 * Converts the literal of `eq`, `ne`, `lt` to `ge`, `in` and `notIn` (one
 * list element at a time) under the left field's type.
 *
 * @param type - The left field's kind and text policy.
 * @param json - The literal in the type's canonical JSON form.
 * @param options - Choice list for choice fields.
 * @returns The literal's value, or an `InvalidValue`: `notComparable` for
 *   password, secret, json and condition, which have no equality.
 */
export const convertLiteral = (
  type: LiteralType,
  json: JsonValue,
  options: LiteralOptions = {}
): Decoded<LiteralValue> => {
  const { kind } = type;

  switch (kind) {
    case "text":
    case "longText": {
      return convertTextLiteral(kind, json, type.textPolicy);
    }

    case "integer": {
      return isJsonNumber(json)
        ? checkInteger(json)
        : wrongType("a JSON number");
    }

    case "bigInteger": {
      return stringLiteral(json, parseBigInteger);
    }

    case "decimal": {
      return stringLiteral(json, parseDecimal);
    }

    case "boolean": {
      return isJsonBoolean(json) ? ok(json) : wrongType("true or false");
    }

    case "date": {
      return stringLiteral(json, parseDate);
    }

    case "dateTime": {
      return stringLiteral(json, parseDateTime);
    }

    case "choice": {
      return convertChoiceLiteral(json, options);
    }

    case "reference":
    case "uuid": {
      return stringLiteral(json, parseUuid);
    }

    case "password":
    case "secret":
    case "json":
    case "condition": {
      return refuse(
        "notComparable",
        "This field type has no literal comparisons; use empty or notEmpty."
      );
    }

    default: {
      return kind satisfies never;
    }
  }
};

const integralInRange = (
  text: string,
  bounds: { readonly min: bigint; readonly max: bigint }
): Decoded<bigint> => {
  const parsed = parseDecimal(text);

  if (!parsed.ok) {
    return parsed;
  }

  const integral = rescaleDecimal(parsed.value, 0);

  if (integral === undefined) {
    return refuse("notInteger", "This field holds whole numbers.");
  }

  const inRange =
    integral.coefficient >= bounds.min && integral.coefficient <= bounds.max;

  return inRange
    ? ok(integral.coefficient)
    : refuse("outOfRange", "The number is outside this field type's range.");
};

/**
 * Converts a number literal written as digits, as the condition text syntax
 * reads it, without passing through a JS `number` (Contracts 5.2).
 *
 * @param kind - The left field's kind: `integer`, `bigInteger` or `decimal`.
 * @param text - Digits such as `-12`, `12.0` or `12.50`.
 * @returns The integer, bigint or decimal, or an `InvalidValue`.
 */
export const convertNumberText = (
  kind: FieldKind,
  text: string
): Decoded<number | bigint | Decimal> => {
  if (kind === "integer") {
    const integral = integralInRange(text, {
      max: BigInt(INTEGER_MAX),
      min: BigInt(INTEGER_MIN),
    });

    return integral.ok ? ok(Number(integral.value)) : integral;
  }

  if (kind === "bigInteger") {
    return integralInRange(text, {
      max: BIG_INTEGER_MAX,
      min: BIG_INTEGER_MIN,
    });
  }

  return kind === "decimal"
    ? parseDecimal(text)
    : wrongType("a value of this field's type, not a number");
};

/**
 * Converts the needle of `contains`, `notContains`, `startsWith` or
 * `endsWith` (steps 1 and 2 of Contracts 5.5, length within the type's
 * limit). Fold it with `likePattern` or `matchesPattern`.
 *
 * @param operator - The pattern operator (`notContains` uses `contains`).
 * @param type - The text field's kind and text policy.
 * @param json - The needle.
 * @returns The NFC needle, or an `InvalidValue`; `emptyNeedle` for an empty
 *   `contains` needle.
 */
export const convertNeedleLiteral = (
  operator: PatternOperator,
  type: FieldTypeOf<"text" | "longText">,
  json: JsonValue
): Decoded<string> => {
  if (!isJsonString(json)) {
    return wrongType("a string");
  }

  if (operator === "contains" && json === "") {
    return refuse("emptyNeedle", "contains needs a non-empty needle.");
  }

  const converted = convertNeedle(json, type.textPolicy);

  return converted.ok
    ? checkLength(converted.value, typeLimit(type.kind))
    : converted;
};
