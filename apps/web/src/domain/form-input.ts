import { parseJson, stringifyJson } from "@std/values/json";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Match, Option, Redacted, Result, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/**
 * What a form input holds for one field, and how it turns into the JSON a
 * write sends (Contracts 6.5, 6.6, 6.7).
 *
 * A form keeps what the user typed per field, by field ID (so an edit
 * survives a rename, decision 0020), as one of a few input shapes. The
 * write body is built from those inputs at save time:
 *
 * - each input converts to the JSON its type takes on the wire: integers
 *   as numbers, big integers and decimals as the typed digits (strings),
 *   dates `YYYY-MM-DD`, date-times as UTC instants, an emptied input as
 *   `null`; text that cannot be shaped (a whole number that is not one,
 *   JSON that does not parse) is a problem of the input, before any rule;
 * - `recordSchema` then judges the body as the server will;
 * - an update sends only fields whose JSON differs from the stored value;
 *   a create sends only fields whose JSON differs from what the create
 *   stores without them (the default, else empty). So an untouched field
 *   is absent, and a cleared one is `null` (6.7).
 *
 * Password and secret values are never plain text here: the input holds
 * them as `Redacted`, and the body keeps them apart (`secrets`) until the
 * request is built.
 */
import type { MetaField } from "./metadata.ts";

const WRITE_ONLY_LABEL = "write-only value";

/**
 * A password or secret as typed: `Redacted` in the Model, in Messages and
 * in Command arguments, so DevTools and its MCP server show only
 * `<redacted:write-only value>`, and JSON encoding refuses it.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const WriteOnlyValue = Schema.Redacted(Schema.String, {
  disallowJsonEncode: true,
  label: WRITE_ONLY_LABEL,
});

/** A password or secret as typed. */
export type WriteOnlyValue = typeof WriteOnlyValue.Type;

/**
 * A typed password or secret, redacted at once.
 *
 * @param typed - The input's text.
 * @returns The redacted value.
 */
export const toWriteOnlyValue = (typed: string): WriteOnlyValue =>
  Redacted.make(typed, { label: WRITE_ONLY_LABEL });

/**
 * What a form input holds for one field.
 *
 * - `Text`: text, long text, integer, big integer, decimal, UUID, json and
 *   condition (JSON text) fields: the text as typed.
 * - `Choice`: the chosen key, `""` for none.
 * - `Flag`: a boolean.
 * - `Day`: a date, `YYYY-MM-DD`.
 * - `Instant`: a date-time as a UTC date and a time (`HH:MM`, `HH:MM:SS`
 *   or `HH:MM:SS.sss`).
 * - `Reference`: the target's ID and its label as the picker showed it.
 * - `WriteOnly`: a new password or secret, or `None` to clear a secret.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const FieldInput = defineTaggedUnion({
  Choice: { key: Schema.String },
  Day: { maybeDate: Schema.Option(Schema.String) },
  Flag: { isChecked: Schema.Boolean },
  Instant: { maybeDate: Schema.Option(Schema.String), time: Schema.String },
  Reference: {
    maybeId: Schema.Option(Schema.String),
    maybeLabel: Schema.Option(Schema.String),
  },
  Text: { text: Schema.String },
  WriteOnly: { maybeValue: Schema.Option(WriteOnlyValue) },
});

/** What a form input holds for one field. */
export type FieldInput = typeof FieldInput.Type;

/** Fields whose input is plain text. */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "uuid",
  "json",
  "condition",
]);

/**
 * Whether a field is a password or secret (write-only, Contracts 6.5).
 *
 * @param field - The field.
 * @returns True for password and secret fields.
 */
export const isWriteOnly = (field: MetaField): boolean =>
  field.type.kind === "password" || field.type.kind === "secret";

const INSTANT_PARTS =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2}:\d{2}:\d{2}\.\d{3})Z$/u;

/**
 * The time part of a stored instant as the form shows it: `HH:MM` when
 * seconds and milliseconds are zero, else as precise as needed.
 *
 * @param time - `HH:MM:SS.sss`.
 * @returns The shortest exact text.
 */
const shortTime = (time: string): string => {
  if (time.endsWith(":00.000")) {
    return time.slice(0, "HH:MM".length);
  }

  return time.endsWith(".000") ? time.slice(0, "HH:MM:SS".length) : time;
};

const textInputOf = (field: MetaField, value: JsonValue): FieldInput => {
  if (value === null) {
    return FieldInput.Text({ text: "" });
  }

  if (field.type.kind === "json" || field.type.kind === "condition") {
    return FieldInput.Text({ text: JSON.stringify(value, null, 2) });
  }

  return FieldInput.Text({
    text: isJsonString(value) ? value : JSON.stringify(value),
  });
};

const stringOf = (value: JsonValue): Option.Option<string> =>
  isJsonString(value) ? Option.some(value) : Option.none();

const instantInputOf = (value: JsonValue): FieldInput => {
  const parts = isJsonString(value) ? INSTANT_PARTS.exec(value) : null;

  return FieldInput.Instant({
    maybeDate: Option.fromNullishOr(parts?.groups?.date),
    time: shortTime(parts?.groups?.time ?? ""),
  });
};

/**
 * The input that shows a stored value (or a create's starting value).
 *
 * @param field - The field.
 * @param value - The value in record JSON (null when empty).
 * @param maybeLabel - The reference's label, when the read permitted one.
 * @returns The input.
 */
export const inputOfValue = (
  field: MetaField,
  value: JsonValue,
  maybeLabel: Option.Option<string>
): FieldInput =>
  Match.value(field.type.kind).pipe(
    Match.withReturnType<FieldInput>(),
    Match.when("boolean", () => FieldInput.Flag({ isChecked: value === true })),
    Match.when("choice", () =>
      FieldInput.Choice({ key: Option.getOrElse(stringOf(value), () => "") })
    ),
    Match.when("date", () => FieldInput.Day({ maybeDate: stringOf(value) })),
    Match.when("dateTime", () => instantInputOf(value)),
    Match.when("reference", () =>
      FieldInput.Reference({ maybeId: stringOf(value), maybeLabel })
    ),
    Match.whenOr("password", "secret", () =>
      FieldInput.WriteOnly({ maybeValue: Option.none() })
    ),
    Match.orElse(() => textInputOf(field, value))
  );

/**
 * The value a create stores for a field the body leaves out (Contracts
 * 6.7): its static default, else empty (`false` for a boolean).
 *
 * @param field - The field.
 * @returns The value.
 */
export const createBaseValue = (field: MetaField): JsonValue =>
  field.default ?? (field.type.kind === "boolean" ? false : null);

const WHOLE_NUMBER = /^[+-]?\d+$/u;

const TIME_TEXT = /^(?<hm>\d{2}:\d{2})(?<s>:\d{2}(?<ms>\.\d{1,3})?)?$/u;

/**
 * The time of a date-time input in the canonical form, `HH:MM:SS.sss`.
 *
 * @param text - The typed time.
 * @returns The time, or none when it is not a time.
 */
const canonicalTime = (text: string): Option.Option<string> => {
  const parts = TIME_TEXT.exec(text.trim());

  if (parts?.groups === undefined) {
    return Option.none();
  }

  const { hm = "", ms = "", s } = parts.groups;
  const seconds = s === undefined ? ":00" : s.slice(0, ":SS".length);

  return Option.some(`${hm}${seconds}.${ms.slice(1).padEnd(3, "0")}`);
};

const textJson = (
  field: MetaField,
  text: string
): Result.Result<JsonValue, string> => {
  const { kind } = field.type;

  if (kind === "text" || kind === "longText") {
    return Result.succeed(text === "" ? null : text);
  }

  const trimmed = text.trim();

  if (trimmed === "") {
    return Result.succeed(null);
  }

  if (kind === "integer") {
    return WHOLE_NUMBER.test(trimmed)
      ? Result.succeed(Number(trimmed))
      : Result.fail("Enter a whole number, such as 42.");
  }

  if (kind === "json" || kind === "condition") {
    const parsed = parseJson(trimmed);

    if (!parsed.ok) {
      return Result.fail(`This is not valid JSON: ${parsed.error.message}`);
    }

    return kind === "condition" && !isJsonObject(parsed.value)
      ? Result.fail("Enter a condition as a JSON object.")
      : Result.succeed(parsed.value);
  }

  return Result.succeed(trimmed);
};

const instantJson = (
  maybeDate: Option.Option<string>,
  time: string
): Result.Result<JsonValue, string> =>
  Option.match(maybeDate, {
    onNone: () =>
      time.trim() === ""
        ? Result.succeed(null)
        : Result.fail("Pick a date for this time."),
    onSome: (date) =>
      Option.match(canonicalTime(time.trim() === "" ? "00:00" : time), {
        onNone: () =>
          Result.fail("Enter the time as HH:MM or HH:MM:SS, in UTC."),
        onSome: (canonical) => Result.succeed(`${date}T${canonical}Z`),
      }),
  });

/**
 * A stand-in for a typed password or secret, so `recordSchema` can judge a
 * body without the value ever being unwrapped outside the request
 * [judgment, decision 0020]: the codec only refuses an empty string (which
 * the input never sends: an emptied input sends nothing) and text that is
 * not well-formed Unicode, which only the server checks.
 */
export const WRITE_ONLY_STAND_IN = "<typed>";

/**
 * The JSON an input sends, or why it cannot be shaped into the field's
 * JSON type. A typed password or secret is the stand-in
 * {@link WRITE_ONLY_STAND_IN}: the real value goes only into the request.
 *
 * @param field - The field.
 * @param input - The input.
 * @returns The value, or a problem for the user.
 */
export const inputJson = (
  field: MetaField,
  input: FieldInput
): Result.Result<JsonValue, string> =>
  Match.value(input).pipe(
    Match.withReturnType<Result.Result<JsonValue, string>>(),
    Match.tag("Text", ({ text }) =>
      TEXT_KINDS.has(field.type.kind)
        ? textJson(field, text)
        : Result.succeed(text)
    ),
    Match.tag("Choice", ({ key }) => Result.succeed(key === "" ? null : key)),
    Match.tag("Flag", ({ isChecked }) => Result.succeed(isChecked)),
    Match.tag("Day", ({ maybeDate }) =>
      Result.succeed(Option.getOrNull(maybeDate))
    ),
    Match.tag("Instant", ({ maybeDate, time }) => instantJson(maybeDate, time)),
    Match.tag("Reference", ({ maybeId }) =>
      Result.succeed(Option.getOrNull(maybeId))
    ),
    Match.tag("WriteOnly", ({ maybeValue }) =>
      Result.succeed(
        Option.match(maybeValue, {
          onNone: (): JsonValue => null,
          onSome: () => WRITE_ONLY_STAND_IN,
        })
      )
    ),
    Match.exhaustive
  );

/**
 * Whether two JSON values are the same value as the wire carries it (keys
 * in any order).
 *
 * @param left - A value.
 * @param right - Another value.
 * @returns True when equal.
 */
export const sameJson = (left: JsonValue, right: JsonValue): boolean =>
  stringifyJson(left) === stringifyJson(right);

/**
 * Whether a write-only input changes what is stored: a new value always
 * does; clearing does only when a value is set.
 *
 * @param input - The input.
 * @param stored - The stored `{"set": bool}`, or null.
 * @returns True when the body must carry it.
 */
const writeOnlyChanges = (
  input: FieldInput,
  stored: JsonValue
): input is typeof FieldInput.WriteOnly.Type =>
  FieldInput.guards.WriteOnly(input) &&
  (Option.isSome(input.maybeValue) ||
    (isJsonObject(stored) && stored.set === true));

/** A write body's values by field name (Contracts 6.6). */
export type FormValues = Readonly<Record<string, JsonValue>>;

/** A write body, with passwords and secrets kept apart until the request. */
export interface FormBody {
  /** Field name to JSON value: every changed field but typed secrets. */
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Field name to a typed password or secret. */
  readonly secrets: Readonly<Record<string, WriteOnlyValue>>;
}

/** One field's part of a body: its name, its input and its base value. */
export interface BodyField {
  readonly field: MetaField;
  readonly input: FieldInput;
  /** The stored value (update) or what a create stores without it. */
  readonly base: JsonValue;
}

/** What building a body found. */
export interface BuiltBody {
  readonly body: FormBody;
  /** Field ID to the problem of an input that could not be shaped. */
  readonly problems: Readonly<Record<string, string>>;
}

/**
 * Builds the write body from the inputs the user changed (Contracts 6.7):
 * a field is in the body only when its JSON differs from its base; a
 * typed secret goes into `secrets`, a cleared one into `values` as null.
 *
 * @param fields - The edited fields, with their inputs and bases.
 * @returns The body and the inputs' problems.
 */
export const buildBody = (fields: readonly BodyField[]): BuiltBody => {
  const writeOnly = fields.filter(
    (entry) =>
      isWriteOnly(entry.field) && writeOnlyChanges(entry.input, entry.base)
  );

  const converted = fields.flatMap((entry) =>
    isWriteOnly(entry.field)
      ? []
      : [{ ...entry, json: inputJson(entry.field, entry.input) }]
  );

  return {
    body: {
      secrets: Object.fromEntries(
        writeOnly.flatMap(({ field, input }) =>
          FieldInput.guards.WriteOnly(input)
            ? Option.match(input.maybeValue, {
                onNone: () => [],
                onSome: (secret) => [[field.name, secret] as const],
              })
            : []
        )
      ),
      values: Object.fromEntries([
        ...converted.flatMap(({ base, field, json }) =>
          Result.isSuccess(json) && !sameJson(json.success, base)
            ? [[field.name, json.success] as const]
            : []
        ),
        ...writeOnly.flatMap(({ field, input }) =>
          FieldInput.guards.WriteOnly(input) && Option.isNone(input.maybeValue)
            ? [[field.name, null] as const]
            : []
        ),
      ]),
    },
    problems: Object.fromEntries(
      converted.flatMap(({ field, json }) =>
        Result.isFailure(json) ? [[field.id, json.failure] as const] : []
      )
    ),
  };
};

/**
 * The body `recordSchema` judges: the values, and each typed secret as
 * {@link WRITE_ONLY_STAND_IN}.
 *
 * @param body - The body.
 * @returns The JSON object.
 */
export const judgedBody = (body: FormBody) => ({
  ...body.values,
  ...Object.fromEntries(
    Object.keys(body.secrets).map((name) => [name, WRITE_ONLY_STAND_IN])
  ),
});

/**
 * The preview body carries only write-only presence, independently of plaintext validation.
 * @param body - Values and redacted inputs.
 * @returns Values with explicit presence markers for typed secrets.
 */
export const formStateBody = (body: FormBody) => ({
  ...body.values,
  ...Object.fromEntries(
    Object.keys(body.secrets).map((name) => [name, { set: true }])
  ),
});

/**
 * The body as the request sends it: secrets unwrapped. Only the save
 * Command calls this, where the request is built.
 *
 * @param body - The body.
 * @returns The JSON object.
 */
export const sentBody = (body: FormBody) => ({
  ...body.values,
  ...Object.fromEntries(
    Object.entries(body.secrets).map(([name, secret]) => [
      name,
      Redacted.value(secret),
    ])
  ),
});
