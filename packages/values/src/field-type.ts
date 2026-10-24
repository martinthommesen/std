/**
 * The field type model (Contracts 6.5): every STD field type, its settings,
 * its Postgres column, the cast used to bind its parameters, and its
 * comparison class (Contracts 5.4).
 *
 * A field type is a flat object with a `kind` and that kind's settings, in
 * JSON form (big integer and decimal bounds are canonical strings), so it can
 * be stored in definitions as is. Omitted settings take their defaults.
 */
import {
  Boolean as SchemaBoolean,
  Int,
  isBetween,
  isPattern,
  Json,
  Literal,
  Literals,
  makeFilter,
  optionalKey,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import {
  compareDecimals,
  DECIMAL_MAX_PRECISION,
  fitDecimal,
  parseDecimal,
} from "./decimal.ts";
import {
  BIG_INTEGER_MAX,
  BIG_INTEGER_MIN,
  compareBigIntegers,
  INTEGER_MAX,
  INTEGER_MIN,
} from "./integer.ts";
import {
  LONG_TEXT_MAX_LENGTH,
  TEXT_DEFAULT_MAX_LENGTH,
  TEXT_MAX_LENGTH_LIMIT,
} from "./text.ts";

/** Every field type kind. */
export const FIELD_KINDS = [
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "choice",
  "reference",
  "uuid",
  "password",
  "secret",
  "json",
  "condition",
] as const;

/** A field type kind. */
export type FieldKind = (typeof FIELD_KINDS)[number];

/** The condition profiles of Contracts 5.10. */
export const ConditionProfileSchema = Literals([
  "filter",
  "accessRule",
  "formRule",
  "recordRule",
  "subscription",
]);

/** A condition profile. */
export type ConditionProfile = typeof ConditionProfileSchema.Type;

const BIG_INTEGER_TEXT = /^-?(?:0|[1-9]\d*)$/u;
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const UUID_TEXT = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

const TextTypeSchema = Struct({
  caseSensitive: optionalKey(SchemaBoolean),
  kind: Literal("text"),
  maxLength: optionalKey(
    Int.check(isBetween({ maximum: TEXT_MAX_LENGTH_LIMIT, minimum: 1 }))
  ),
  nonBlank: optionalKey(SchemaBoolean),
  textPolicy: optionalKey(Literals(["normalized", "freeText"])),
});

const LongTextTypeSchema = Struct({
  caseSensitive: optionalKey(SchemaBoolean),
  kind: Literal("longText"),
  maxLength: optionalKey(
    Int.check(isBetween({ maximum: LONG_TEXT_MAX_LENGTH, minimum: 1 }))
  ),
  nonBlank: optionalKey(SchemaBoolean),
  textPolicy: optionalKey(Literals(["normalized", "freeText"])),
});

const IntegerBound = Int.check(
  isBetween({ maximum: INTEGER_MAX, minimum: INTEGER_MIN })
);

const IntegerTypeSchema = Struct({
  kind: Literal("integer"),
  max: optionalKey(IntegerBound),
  min: optionalKey(IntegerBound),
});

const BigIntegerBound = SchemaString.check(isPattern(BIG_INTEGER_TEXT));

const BigIntegerTypeSchema = Struct({
  kind: Literal("bigInteger"),
  max: optionalKey(BigIntegerBound),
  min: optionalKey(BigIntegerBound),
});

const DecimalBound = SchemaString.check(isPattern(DECIMAL_TEXT));

const DecimalTypeSchema = Struct({
  kind: Literal("decimal"),
  max: optionalKey(DecimalBound),
  min: optionalKey(DecimalBound),
  precision: Int.check(
    isBetween({ maximum: DECIMAL_MAX_PRECISION, minimum: 1 })
  ),
  scale: Int.check(isBetween({ maximum: DECIMAL_MAX_PRECISION, minimum: 0 })),
});

/**
 * A reference names its target class and, optionally, an allowed-records
 * condition over that class (decision 0020): a condition AST (Contracts
 * 5.2, field IDs) that a target must satisfy, under the filter profile in
 * the writer's view. Here it is any JSON; `@std/definitions` checks it as
 * a condition when the field is stored. Absent (or null): no condition.
 *
 * `aggregate: true` (from Step 3, Contracts 4.9, 6.5) makes the field its
 * class's owner reference: the records of the class are parts of the
 * record it names. Absent means false; the setting is fixed at creation.
 */
const ReferenceTypeSchema = Struct({
  aggregate: optionalKey(SchemaBoolean),
  allowedRecords: optionalKey(Json),
  kind: Literal("reference"),
  targetClassId: SchemaString.check(isPattern(UUID_TEXT)),
});

/**
 * A condition field names the class whose fields its conditions may name
 * (`classId`, like a reference's target) and the profile they are checked
 * under (Contracts 5.2, 6.5).
 */
const ConditionTypeSchema = Struct({
  classId: SchemaString.check(isPattern(UUID_TEXT)),
  kind: Literal("condition"),
  profile: ConditionProfileSchema,
});

const plain = <K extends FieldKind>(kind: K) => Struct({ kind: Literal(kind) });

const boundsInOrder = (
  min: string | number | undefined,
  max: string | number | undefined,
  compare: (left: string, right: string) => number
): boolean =>
  min === undefined ||
  max === undefined ||
  compare(String(min), String(max)) <= 0;

const compareBigIntegerText = (left: string, right: string): number =>
  compareBigIntegers(BigInt(left), BigInt(right));

const compareDecimalText = (left: string, right: string): number => {
  const a = parseDecimal(left);
  const b = parseDecimal(right);

  return a.ok && b.ok ? compareDecimals(a.value, b.value) : 0;
};

const bigIntegerBoundInRange = (bound: string | undefined): boolean =>
  bound === undefined ||
  (BigInt(bound) >= BIG_INTEGER_MIN && BigInt(bound) <= BIG_INTEGER_MAX);

const decimalBoundFits = (
  bound: string | undefined,
  precision: number,
  scale: number
): boolean => {
  if (bound === undefined) {
    return true;
  }

  const parsed = parseDecimal(bound);

  return parsed.ok && fitDecimal(parsed.value, precision, scale).ok;
};

const BOUNDS_OUT_OF_ORDER = "min must not exceed max";

const decimalSettingsProblem = (
  type: typeof DecimalTypeSchema.Type
): string | undefined => {
  if (type.scale > type.precision) {
    return "scale must not exceed precision";
  }

  const boundsFit =
    decimalBoundFits(type.min, type.precision, type.scale) &&
    decimalBoundFits(type.max, type.precision, type.scale);

  if (!boundsFit) {
    return "bounds must fit the precision and scale";
  }

  return boundsInOrder(type.min, type.max, compareDecimalText)
    ? undefined
    : BOUNDS_OUT_OF_ORDER;
};

const bigIntegerSettingsProblem = (
  type: typeof BigIntegerTypeSchema.Type
): string | undefined => {
  if (!bigIntegerBoundInRange(type.min) || !bigIntegerBoundInRange(type.max)) {
    return "bounds must be big integers";
  }

  return boundsInOrder(type.min, type.max, compareBigIntegerText)
    ? undefined
    : BOUNDS_OUT_OF_ORDER;
};

const integerBoundsInOrder = (type: typeof IntegerTypeSchema.Type): boolean =>
  type.min === undefined || type.max === undefined || type.min <= type.max;

const FieldTypeUnion = Union([
  TextTypeSchema,
  LongTextTypeSchema,
  IntegerTypeSchema,
  BigIntegerTypeSchema,
  DecimalTypeSchema,
  plain("boolean"),
  plain("date"),
  plain("dateTime"),
  plain("choice"),
  ReferenceTypeSchema,
  plain("uuid"),
  plain("password"),
  plain("secret"),
  plain("json"),
  ConditionTypeSchema,
]);

const settingsProblem = (
  type: typeof FieldTypeUnion.Type
): string | undefined => {
  if (type.kind === "decimal") {
    return decimalSettingsProblem(type);
  }

  if (type.kind === "bigInteger") {
    return bigIntegerSettingsProblem(type);
  }

  if (type.kind === "integer" && !integerBoundsInOrder(type)) {
    return BOUNDS_OUT_OF_ORDER;
  }

  return undefined;
};

/** The JSON form of every field type, with cross-setting checks. */
export const FieldTypeSchema = FieldTypeUnion.check(
  makeFilter((type) => settingsProblem(type) ?? true)
);

/** A field type with its settings. */
export type FieldType = typeof FieldTypeSchema.Type;

/** The field type of one kind. */
export type FieldTypeOf<K extends FieldKind> = Extract<
  FieldType,
  { readonly kind: K }
>;

/**
 * The maximum length of a text or long text field.
 *
 * @param type - A text or long text type.
 * @returns The limit in code points (default 255 for text, 1,000,000 for long
 *   text).
 */
export const maxLengthOf = (type: FieldTypeOf<"text" | "longText">): number =>
  type.maxLength ??
  (type.kind === "text" ? TEXT_DEFAULT_MAX_LENGTH : LONG_TEXT_MAX_LENGTH);

/**
 * Whether a text field compares case-sensitively.
 *
 * @param type - A text or long text type.
 * @returns The `caseSensitive` setting, false by default.
 */
export const isCaseSensitive = (
  type: FieldTypeOf<"text" | "longText">
): boolean => type.caseSensitive ?? false;

/** How a field type is stored in Postgres. */
export interface PostgresColumn {
  /** The column type, such as `numeric(10,2)`. */
  readonly sqlType: string;
  /** Whether the column is `NOT NULL` (boolean only). */
  readonly notNull: boolean;
  /** The column default expression, if any. */
  readonly defaultExpression?: string;
  /**
   * The CHECK expression for a quoted column identifier, if the type has one.
   *
   * @param column - The quoted column name.
   * @returns The boolean SQL expression.
   */
  readonly check?: (column: string) => string;
}

const COLUMN_TYPES: Readonly<Record<FieldKind, string>> = {
  bigInteger: "bigint",
  boolean: "boolean",
  choice: "text",
  condition: "jsonb",
  date: "date",
  dateTime: "timestamptz(3)",
  decimal: "numeric",
  integer: "integer",
  json: "jsonb",
  longText: "text",
  password: "text",
  reference: "uuid",
  secret: "bytea",
  text: "text",
  uuid: "uuid",
};

/**
 * The Postgres column for a field type. References also get a foreign key
 * `ON DELETE NO ACTION` (Contracts 3.10), which the schema engine adds.
 *
 * @param type - The field type.
 * @returns The column type, nullability, default and CHECK.
 */
export const postgresColumn = (type: FieldType): PostgresColumn => {
  if (type.kind === "text") {
    const maxLength = maxLengthOf(type);

    return {
      check: (column) => `char_length(${column}) <= ${maxLength}`,
      notNull: false,
      sqlType: "text",
    };
  }

  if (type.kind === "decimal") {
    return {
      notNull: false,
      sqlType: `numeric(${type.precision},${type.scale})`,
    };
  }

  if (type.kind === "boolean") {
    return { defaultExpression: "false", notNull: true, sqlType: "boolean" };
  }

  return { notNull: false, sqlType: COLUMN_TYPES[type.kind] };
};

const PARAMETER_CASTS: Readonly<Record<FieldKind, string>> = {
  bigInteger: "int8",
  boolean: "boolean",
  choice: "text",
  condition: "jsonb",
  date: "date",
  dateTime: "timestamptz",
  decimal: "numeric",
  integer: "int4",
  json: "jsonb",
  longText: "text",
  password: "text",
  reference: "uuid",
  secret: "bytea",
  text: "text",
  uuid: "uuid",
};

/**
 * The cast for a bound text parameter of this kind, as in `$1::numeric`.
 * Decimal literals are cast to unconstrained `numeric`, never
 * `numeric(p, s)`, which would round a literal that exceeds the scale.
 *
 * @param kind - The field kind.
 * @returns The Postgres type name to cast to.
 */
export const parameterCast = (kind: FieldKind): string => PARAMETER_CASTS[kind];

/** Comparison classes: values compare only within one class (Contracts 5.4). */
export type ComparisonClass =
  | "text"
  | "numeric"
  | "boolean"
  | "date"
  | "dateTime"
  | "choice"
  | "uuid";

const COMPARISON_CLASSES: Readonly<Record<FieldKind, ComparisonClass | null>> =
  {
    bigInteger: "numeric",
    boolean: "boolean",
    choice: "choice",
    condition: null,
    date: "date",
    dateTime: "dateTime",
    decimal: "numeric",
    integer: "numeric",
    json: null,
    longText: "text",
    password: null,
    reference: "uuid",
    secret: null,
    text: "text",
    uuid: "uuid",
  };

/**
 * The comparison class of a kind. Integer, big integer and decimal form one
 * numeric class; reference and uuid compare as UUIDs.
 *
 * @param kind - The field kind.
 * @returns The class, or null for password, secret, json and condition,
 *   which have no equality.
 */
export const comparisonClass = (kind: FieldKind): ComparisonClass | null =>
  COMPARISON_CLASSES[kind];

const ORDERED_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "integer",
  "bigInteger",
  "decimal",
  "date",
  "dateTime",
]);

/**
 * Whether `lt` to `ge` apply (Contracts 5.4): integer, big integer, decimal,
 * date and date-time. Text has no order.
 *
 * @param kind - The field kind.
 * @returns True for ordered kinds.
 */
export const isOrdered = (kind: FieldKind): boolean => ORDERED_KINDS.has(kind);

/**
 * Whether `contains`, `startsWith` and `endsWith` apply.
 *
 * @param kind - The field kind.
 * @returns True for text and long text.
 */
export const isTextKind = (kind: FieldKind): kind is "text" | "longText" =>
  kind === "text" || kind === "longText";

/**
 * Whether a field type is an owner reference (Contracts 4.9, 6.5): a
 * reference declared `aggregate: true`.
 *
 * @param type - A field type.
 * @returns True for an owner reference.
 */
export const isOwnerReferenceType = (type: FieldType): boolean =>
  type.kind === "reference" && type.aggregate === true;
