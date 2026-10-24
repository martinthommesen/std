/**
 * `recordSchema(table, mode)` (Contracts 6.3): the one builder of the
 * Schema that validates a record's values, from table metadata
 * (`table-metadata.ts`).
 *
 * The browser builds it from the filtered metadata the server sends; the
 * server's save pipeline runs the same field rules (`record-rules.ts`) on
 * full definitions, and the metadata carries exactly what those rules read
 * of each field (`rulesOfMetaField` rebuilds them). So for every field both
 * sides see, both give the same verdict.
 *
 * The Schema decodes a write body (a JSON object of field names to values)
 * and reports one issue per failing field, at the field's name. The verdict
 * mirrors the save pipeline step by step:
 *
 * - Keys are resolved first: a name the metadata does not hold is unknown
 *   (the server answers `UnknownField`, and nothing else), and a system
 *   member (`id`, `class`, `version`, audit fields) is `ReadOnlyField`
 *   (only those are reported then).
 * - `create`: each supplied value is converted under the field's type and
 *   choices; an absent active field gets its default or empty value; every
 *   value is rechecked as the pipeline does after before-write hooks; a
 *   supplied field counts as written when it is retired or differs from what
 *   the create stores without it; then `InvalidValue`, or `DefinitionRetired`
 *   / `ReadOnlyField` when written and `Required` when empty.
 * - `update`: supplied values are converted against the stored record (an
 *   unchanged retired choice key is kept); a field is written when it is
 *   invalid, withheld from the caller on this record, or changed; when no
 *   field is written the save is a no-op and nothing is refused. `Required`
 *   is judged over the body value, else the stored value, and left out when
 *   the stored value was not delivered.
 * - `read`: every delivered value must be canonical JSON of its type.
 *
 * Checks only the server can make are not here: uniqueness, reference
 * targets, access rules, a condition value's check against the caller's
 * view of its table (`invalidCondition`), form rules, stale revisions and
 * versions.
 */
import { decodeIn } from "@std/values/codec";
import { storedEquals } from "@std/values/compare";
import type { StoredOrPlaintext } from "@std/values/compare";
import type { InvalidValue } from "@std/values/field-error";
import type { FieldType } from "@std/values/field-type";
import { isBoolean } from "@std/values/field-value";
import type { DecodedInput } from "@std/values/field-value";
import { parseJson, stringifyJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { LONG_TEXT_MAX_LENGTH, TEXT_MAX_LENGTH_LIMIT } from "@std/values/text";
import { secretState } from "@std/values/write-only";
import { isFailure } from "effect/Result";
import {
  Json,
  makeFilter,
  Record as SchemaRecord,
  String as SchemaString,
} from "effect/Schema";
import type { FilterIssue } from "effect/Schema";
import { InvalidValue as InvalidValueIssue } from "effect/SchemaIssue";
import { decodeUnknownResult } from "effect/SchemaParser";

import { invalidValue } from "./field-errors.ts";
import type { FieldError } from "./field-errors.ts";
import { SYSTEM_API_NAMES } from "./names.ts";
import {
  absentCreateValue,
  choiceListOf,
  convertCreate,
  convertUpdate,
  fieldErrorsOf,
  recheckValue,
  rulesOnUpdate,
  writtenOnCreate,
} from "./record-rules.ts";
import type { FieldRules } from "./record-rules.ts";
import type { MetaField, MetaFieldType, MetaTable } from "./table-metadata.ts";

/** What a record Schema validates: a create, an update or a read. */
export type RecordMode = "create" | "update" | "read";

/**
 * A stored record's values as a read delivered them (`record.values` of
 * Contracts 6.6): an absent key was withheld or not selected.
 */
export type StoredValues = Readonly<Record<string, JsonValue>>;

/**
 * The stored record an update starts from, as a read delivered it
 * (Contracts 6.6): its concrete class (`class`, a qualified table name)
 * and its `values`, holding at least every field the body names.
 */
export interface StoredRecord {
  readonly class: string;
  readonly values: StoredValues;
}

/** Options of an update's Schema. */
export interface UpdateOptions {
  /**
   * The endpoint the update is sent through, when it is an ancestor of the
   * record's concrete class: body names resolve against its fields (a
   * child-only name is unknown there, as on the server), while the rules
   * stay the concrete class's.
   */
  readonly through?: MetaTable;
}

/** The verdict of one body. */
export interface RecordVerdict {
  /** Whether the body is not a JSON object (the server's `InvalidRequest`). */
  readonly invalidBody: boolean;
  /** Names that resolve to no field (the server's `UnknownField`). */
  readonly unknownFields: readonly string[];
  /** Every field error, in field order. */
  readonly errors: readonly FieldError[];
}

/** The system members of a record (Contracts 3.2, 6.6), never writable. */
export const SYSTEM_MEMBER_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SYSTEM_API_NAMES),
  "class",
]);

// A syntactically valid ID for the codec: `decodeIn` reads no setting of a
// reference (only the UUID format) or of a condition (only that the value
// is a JSON object), so the placeholder never affects a verdict.
const NO_CLASS = "00000000-0000-0000-0000-000000000000";

/**
 * The field type the codec converts with, from a metadata type.
 *
 * @param type - The metadata type.
 * @returns The field type.
 */
export const codecTypeOf = (type: MetaFieldType): FieldType => {
  if (type.kind === "reference") {
    // An owner reference stays one: an update may not change it (4.9).
    return type.aggregate === true
      ? { aggregate: true, kind: "reference", targetClassId: NO_CLASS }
      : { kind: "reference", targetClassId: NO_CLASS };
  }

  if (type.kind === "condition") {
    return { classId: NO_CLASS, kind: "condition", profile: type.profile };
  }

  return type;
};

/**
 * The field rules a metadata field carries: the same values the server
 * reads from full definitions (`fieldRulesOf`).
 *
 * @param field - A metadata field.
 * @returns Its rules.
 */
export const rulesOfMetaField = (field: MetaField): FieldRules => ({
  autoNumber: field.autoNumber !== null,
  choices:
    field.choices === null
      ? null
      : choiceListOf(
          field.choices.map((choice) => ({
            hidden: choice.retired,
            key: choice.key,
          }))
        ),
  default: field.default,
  id: field.id,
  name: field.name,
  readOnly: field.readOnly,
  required: field.required,
  state: field.state,
  type: codecTypeOf(field.type),
});

// A stored value is converted without the bounds and lengths a later
// override may have tightened: it is what is stored, not a new value.
const storedTypeOf = (type: FieldType): FieldType => {
  if (type.kind === "text") {
    return { ...type, maxLength: TEXT_MAX_LENGTH_LIMIT };
  }

  if (type.kind === "longText") {
    return { ...type, maxLength: LONG_TEXT_MAX_LENGTH };
  }

  if (type.kind === "integer" || type.kind === "bigInteger") {
    return { kind: type.kind };
  }

  if (type.kind === "decimal") {
    return { kind: "decimal", precision: type.precision, scale: type.scale };
  }

  return type;
};

/**
 * A delivered value as the server holds it stored.
 *
 * @param type - The field type.
 * @param json - The delivered canonical JSON.
 * @returns The stored value, or undefined when it does not convert.
 */
const storedValueOf = (
  type: FieldType,
  json: JsonValue
): StoredOrPlaintext | undefined => {
  if (type.kind === "password" || type.kind === "secret") {
    const set = isJsonObject(json) ? json.set : undefined;

    return isBoolean(set) ? secretState(set) : undefined;
  }

  const decoded = decodeIn(storedTypeOf(type), json);

  return decoded.ok ? decoded.value : undefined;
};

/** The fields' proposal: converted values and refusals, by name. */
interface Proposal {
  readonly values: Map<string, DecodedInput>;
  readonly invalid: Map<string, InvalidValue>;
}

/** The body's keys, resolved against the metadata. */
interface ResolvedBody {
  readonly unknown: readonly string[];
  readonly system: readonly string[];
  readonly entries: ReadonlyMap<string, JsonValue>;
}

const resolveBody = (
  byName: ReadonlyMap<string, FieldRules>,
  nameable: ReadonlySet<string>,
  body: JsonObject
): ResolvedBody => {
  const unknown: string[] = [];
  const system: string[] = [];
  const entries = new Map<string, JsonValue>();

  for (const [name, json] of Object.entries(body)) {
    if (SYSTEM_MEMBER_NAMES.has(name)) {
      system.push(name);
    } else if (!nameable.has(name)) {
      unknown.push(name);
    } else if (byName.has(name)) {
      entries.set(name, json);
    }
  }

  return { entries, system, unknown };
};

// The pipeline's recheck after before-write hooks (`finalize*`): every
// value is converted again from its canonical form.
const recheck = (
  fields: readonly FieldRules[],
  proposal: Proposal,
  stored: (rules: FieldRules) => StoredOrPlaintext | undefined
): Proposal => {
  const values = new Map<string, DecodedInput>();
  const invalid = new Map(proposal.invalid);

  for (const rules of fields) {
    const value = proposal.values.get(rules.name);

    if (proposal.values.has(rules.name) && value !== undefined) {
      const rechecked = recheckValue(rules, value, stored(rules) ?? null);

      if (!invalid.has(rules.name)) {
        if (rechecked.ok) {
          values.set(rules.name, rechecked.value);
        } else {
          invalid.set(rules.name, rechecked.error);
        }
      }
    }
  }

  return { invalid, values };
};

const errorsOf = (
  fields: readonly FieldRules[],
  proposal: Proposal,
  written: ReadonlySet<string>,
  candidateOf: (rules: FieldRules) => {
    readonly known: boolean;
    readonly value: StoredOrPlaintext | undefined;
  }
): FieldError[] =>
  fields.flatMap((rules) => {
    const refused = proposal.invalid.get(rules.name);

    if (refused !== undefined) {
      return [invalidValue(rules.name, refused)];
    }

    const candidate = candidateOf(rules);

    return fieldErrorsOf(
      rules,
      candidate.value,
      written.has(rules.name)
    ).filter((error) => candidate.known || error._tag !== "Required");
  });

const createErrors = (
  fields: readonly FieldRules[],
  byName: ReadonlyMap<string, FieldRules>,
  entries: ReadonlyMap<string, JsonValue>
): FieldError[] => {
  const values = new Map<string, DecodedInput>();
  const invalid = new Map<string, InvalidValue>();

  for (const rules of fields) {
    const json = entries.get(rules.name);

    if (entries.has(rules.name) && json !== undefined) {
      const converted = convertCreate(rules, json);

      if (converted.ok) {
        values.set(rules.name, converted.value);
      } else {
        invalid.set(rules.name, converted.error);
      }
    } else if (rules.state === "active") {
      values.set(rules.name, absentCreateValue(rules));
    }
  }

  const final = recheck(fields, { invalid, values }, () => null);

  const written = new Set(
    [...entries.keys()].filter((name) => {
      const rules = byName.get(name);
      const value = final.values.get(name);

      return (
        rules === undefined ||
        value === undefined ||
        writtenOnCreate(rules, value)
      );
    })
  );

  return errorsOf(fields, final, written, (rules) => ({
    known: true,
    value: final.values.get(rules.name),
  }));
};

const updateWritten = (
  fields: readonly FieldRules[],
  proposal: Proposal,
  storedOf: (rules: FieldRules) => StoredOrPlaintext | undefined,
  readable: (name: string) => boolean
): Set<string> =>
  new Set(
    fields.flatMap((rules) => {
      const { name } = rules;
      const value = proposal.values.get(name);
      const supplied = proposal.values.has(name) || proposal.invalid.has(name);

      if (!supplied) {
        return [];
      }

      const changed =
        value === undefined ||
        !storedEquals(rules.type.kind, storedOf(rules) ?? null, value);

      return !readable(name) || proposal.invalid.has(name) || changed
        ? [name]
        : [];
    })
  );

const updateErrors = (
  fields: readonly FieldRules[],
  entries: ReadonlyMap<string, JsonValue>,
  stored: StoredValues
): FieldError[] => {
  const storedValues = new Map<string, StoredOrPlaintext | undefined>();

  const storedOf = (rules: FieldRules): StoredOrPlaintext | undefined => {
    if (storedValues.has(rules.name)) {
      return storedValues.get(rules.name);
    }

    const json = Object.hasOwn(stored, rules.name)
      ? stored[rules.name]
      : undefined;

    const value =
      json === undefined ? undefined : storedValueOf(rules.type, json);

    storedValues.set(rules.name, value);

    return value;
  };

  const readable = (name: string): boolean => Object.hasOwn(stored, name);
  const values = new Map<string, DecodedInput>();
  const invalid = new Map<string, InvalidValue>();

  for (const rules of fields) {
    const json = entries.get(rules.name);

    if (entries.has(rules.name) && json !== undefined) {
      const converted = convertUpdate(rules, json, storedOf(rules));

      if (converted.ok) {
        values.set(rules.name, converted.value);
      } else {
        invalid.set(rules.name, converted.error);
      }
    }
  }

  if (
    updateWritten(fields, { invalid, values }, storedOf, readable).size === 0
  ) {
    return [];
  }

  const final = recheck(fields, { invalid, values }, storedOf);
  const written = updateWritten(fields, final, storedOf, readable);

  if (written.size === 0) {
    return [];
  }

  return errorsOf(fields, final, written, (rules) =>
    final.values.has(rules.name)
      ? { known: true, value: final.values.get(rules.name) }
      : { known: readable(rules.name), value: storedOf(rules) }
  );
};

const readErrors = (
  fields: readonly FieldRules[],
  entries: ReadonlyMap<string, JsonValue>
): FieldError[] =>
  fields.flatMap((rules) => {
    const json = entries.get(rules.name);

    if (json === undefined) {
      return [];
    }

    const { kind } = rules.type;

    if (kind === "password" || kind === "secret") {
      return storedValueOf(rules.type, json) === undefined
        ? [
            {
              _tag: "InvalidValue",
              field: rules.name,
              message: 'Expected {"set": true} or {"set": false}.',
              reason: "wrongJsonType",
            } satisfies FieldError,
          ]
        : [];
    }

    const decoded = decodeIn(storedTypeOf(rules.type), json);

    return decoded.ok ? [] : [invalidValue(rules.name, decoded.error)];
  });

/**
 * The verdict of one body, without the Schema around it.
 *
 * @param table - The table's metadata.
 * @param mode - Create, update or read.
 * @param body - The body's values object.
 * @param stored - The stored record's delivered values (update).
 * @param nameable - The names the endpoint resolves.
 * @returns Unknown names and field errors.
 */
const verdictOf = (
  table: MetaTable,
  mode: RecordMode,
  body: JsonObject,
  stored: StoredValues,
  nameable: ReadonlySet<string>
): Omit<RecordVerdict, "invalidBody"> => {
  const fields = table.fields.map(rulesOfMetaField);

  // The server parses a body before anything else and refuses all of it
  // (`InvalidRequest`) when a value breaks the json rules on the wire:
  // U+0000, a number a double does not hold exactly. Such a value is
  // refused on its own field here, first.
  const unsendable = Object.entries(body).flatMap(([name, json]) => {
    const sent = parseJson(stringifyJson(json));

    return sent.ok ? [] : [invalidValue(name, sent.error)];
  });

  if (unsendable.length > 0) {
    return { errors: unsendable, unknownFields: [] };
  }

  const byName = new Map(fields.map((rules) => [rules.name, rules]));
  const resolved = resolveBody(byName, nameable, body);

  if (resolved.unknown.length > 0) {
    return { errors: [], unknownFields: resolved.unknown };
  }

  if (resolved.system.length > 0 && mode !== "read") {
    return {
      errors: resolved.system.map((name) => ({
        _tag: "ReadOnlyField",
        field: name,
      })),
      unknownFields: [],
    };
  }

  if (mode === "create") {
    return {
      errors: createErrors(fields, byName, resolved.entries),
      unknownFields: [],
    };
  }

  if (mode === "update") {
    const onUpdate = fields.map(rulesOnUpdate);

    return {
      errors: updateErrors(onUpdate, resolved.entries, stored),
      unknownFields: [],
    };
  }

  return { errors: readErrors(fields, resolved.entries), unknownFields: [] };
};

const issuesOf = (
  verdict: Omit<RecordVerdict, "invalidBody">
): FilterIssue[] => [
  ...verdict.unknownFields.map((name) => ({
    issue: new InvalidValueIssue({
      message: "This table has no field of this name.",
    }),
    path: [name],
  })),
  ...verdict.errors.map((error) => ({
    issue: new InvalidValueIssue({
      message: error._tag === "InvalidValue" ? error.message : error._tag,
    }),
    path: [error.field],
  })),
];

const BodySchema = SchemaRecord(SchemaString, Json);

const NO_VALUES: StoredValues = {};

// An update is validated with the rules of the record's concrete class,
// as the save pipeline does (Contracts 2.2 item 5): a child's overrides
// apply through a parent endpoint too. Metadata of another class would
// give another verdict, so it is refused loudly instead of guessed at.
const updateValues = (
  table: MetaTable,
  stored: StoredRecord | undefined,
  options: UpdateOptions
): StoredValues => {
  if (stored === undefined) {
    throw new TypeError(
      "recordSchema: an update needs the stored record (its class and values)."
    );
  }

  if (stored.class !== table.name) {
    throw new RangeError(
      `recordSchema: an update of a ${stored.class} record is validated with the metadata of ${stored.class}, not ${table.name}.`
    );
  }

  const { through } = options;

  const reaches =
    through === undefined ||
    through.name === table.name ||
    table.ancestors.some((ancestor) => ancestor.name === through.name);

  if (!reaches) {
    throw new RangeError(
      `recordSchema: ${table.name} records cannot be updated through ${through.name}.`
    );
  }

  return stored.values;
};

const preparationOf = (
  table: MetaTable,
  mode: RecordMode,
  stored: StoredRecord | undefined,
  options: UpdateOptions
) => {
  const values =
    mode === "update" ? updateValues(table, stored, options) : NO_VALUES;

  return {
    nameable: new Set(
      (options.through ?? table).fields.map((field) => field.name)
    ),
    values,
  };
};

/**
 * The Schema of a record's values for one table and mode: it decodes a
 * body object and fails with one issue per failing field, at the field's
 * name.
 *
 * - `create`: `table` is the endpoint's metadata (a create makes a record
 *   of exactly the endpoint's class).
 * - `update`: `table` must be the metadata of the record's concrete class
 *   (`stored.class`, the `class` member of the record as read), whatever
 *   endpoint the update goes through; `options.through` names that
 *   endpoint when it is an ancestor. Other metadata is a defect (thrown):
 *   the verdict would not be the server's.
 * - `read`: `table` is the metadata of the endpoint the values were read
 *   through.
 *
 * @param table - The table's metadata (`TableMetadata.table`).
 * @param mode - `create`, `update` or `read`.
 * @param stored - For an update, the stored record (class and values).
 * @param options - For an update, the endpoint it is sent through.
 * @returns The Schema.
 */
export const recordSchema = (
  table: MetaTable,
  mode: RecordMode,
  stored?: StoredRecord,
  options: UpdateOptions = {}
) => {
  const { values, nameable } = preparationOf(table, mode, stored, options);

  return BodySchema.check(
    makeFilter((body) => {
      const issues = issuesOf(verdictOf(table, mode, body, values, nameable));

      return issues.length === 0 ? undefined : issues;
    })
  );
};

/**
 * Validates a body with the shared record rules and returns the verdict per field.
 *
 * @param table - The table's metadata.
 * @param mode - `create`, `update` or `read`.
 * @param body - The body, as the form would send it.
 * @param stored - For an update, the stored record (class and values).
 * @param options - For an update, the endpoint it is sent through.
 * @returns Whether the body is an object, unknown names and field errors.
 */
export const validateRecord = (
  table: MetaTable,
  mode: RecordMode,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a form body is validated from any input
  body: unknown,
  stored?: StoredRecord,
  options: UpdateOptions = {}
): RecordVerdict => {
  const { values, nameable } = preparationOf(table, mode, stored, options);
  const result = decodeUnknownResult(BodySchema)(body);

  if (isFailure(result)) {
    return { errors: [], invalidBody: true, unknownFields: [] };
  }

  const verdict = verdictOf(table, mode, result.success, values, nameable);

  return {
    errors: verdict.errors,
    invalidBody: false,
    unknownFields: verdict.unknownFields,
  };
};
