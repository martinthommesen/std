/**
 * The per-table OpenAPI 3.1 document (Contracts 6.1, 6.3): the generic
 * record routes of one table, with record values described from the
 * caller's metadata, so it shows exactly the fields the metadata shows and
 * nothing else. It states the schema revision it describes: `info.version`
 * is `<revision>.<change_set_id>` (the `STD-Schema-Revision` form) and
 * `x-std-schema-revision` the number.
 *
 * Field schemas follow Contracts 6.5: big integers and decimals are
 * strings, date-times RFC 3339, references and UUIDs lowercase UUIDs,
 * password and secret values `{"set": bool}` when read and plaintext when
 * written, choices the keys of the table's choices.
 *
 * The document never refuses traffic the server accepts; where JSON Schema
 * cannot say what the server checks, it says less and describes the rest:
 *
 * - Read values hold the selected fields, the audit fields and, for a
 *   `fields` selection naming reference paths, dotted members
 *   (`docked_to.name`).
 * - Read schemas describe each type's canonical output (`encodeOut`), write
 *   schemas the input its codec accepts (`decodeIn`): big integers with
 *   leading zeros, decimals at any scale, date-times with offsets, UUIDs in
 *   any case. What a pattern cannot say (ranges, calendar validity, scale)
 *   is described and left to the server.
 * - A create body may name active choice keys; an update body also the
 *   hidden ones, which the server keeps only when unchanged (6.5). A
 *   choice field with no writable key accepts only null. Read values accept
 *   any key, since a stored key outlives its choice's deletion.
 * - Write bodies accept members they do not list: the server accepts
 *   fields the caller may write but not read (3.4), and the document never
 *   names a field the caller cannot read.
 * - Write bodies name every field the caller can read: forms send whole
 *   records, and an unchanged field the caller may not write is accepted
 *   (3.9). `x-std-write` states whether the caller may write it (`yes`,
 *   `no`, `perRecord`), and a read-only field is marked `readOnly`.
 * - Text lengths bound read values; written text is converted first
 *   (trimmed, normalized, Contracts 5.5), so its limit is described, not
 *   enforced.
 */
import type {
  MetaField,
  MetaFieldType,
  MetaTable,
} from "@std/definitions/table-metadata";
import type { JsonObject, JsonValue } from "@std/values/json-value";

/** How the document describes the revision it was built at. */
export interface DocumentRevision {
  readonly revision: number;
  /** `<revision>.<change_set_id>`. */
  readonly header: string;
}

const nullable = (schema: JsonObject): JsonObject => ({
  anyOf: [schema, { type: "null" }],
});

// Patterns of each type's canonical output (`encodeOut`, Contracts 6.5)
// and of the input its codec accepts (`decodeIn`). An input pattern is the
// parser's own format check; what a pattern cannot express (ranges,
// calendar validity, digit counts) the server checks and the schema only
// describes, so the document accepts a superset of what the server accepts
// and never refuses accepted input.
const BIG_INTEGER_OUT = "^-?(0|[1-9][0-9]*)$";
const BIG_INTEGER_IN = "^-?[0-9]+$";
const DECIMAL_IN = "^-?[0-9]+(\\.[0-9]+)?$";
const DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

const DATE_TIME_OUT =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

const DATE_TIME_IN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$";

const UUID_OUT =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const UUID_IN =
  "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";

const CHOICE_KEY = "^[0-9a-z][0-9_a-z]{0,62}$";

/**
 * The canonical decimal of a scale: exactly `scale` fraction digits.
 *
 * @param scale - The field's scale.
 * @returns The pattern.
 */
const decimalOut = (scale: number): string =>
  scale === 0 ? "^-?(0|[1-9][0-9]*)$" : `^-?(0|[1-9][0-9]*)\\.[0-9]{${scale}}$`;

const boundsOf = (
  type: Extract<MetaFieldType, { readonly kind: "integer" }>
): JsonObject => {
  const bounds: Record<string, JsonValue> = {};

  if (type.min !== undefined) {
    bounds.minimum = type.min;
  }

  if (type.max !== undefined) {
    bounds.maximum = type.max;
  }

  return bounds;
};

/** Which values a schema describes: a read, or a create or update body. */
type ValueMode = "read" | "create" | "update";

const textSchema = (
  maxLength: number | undefined,
  mode: ValueMode
): JsonObject => {
  if (maxLength === undefined) {
    return { type: "string" };
  }

  return mode === "read"
    ? { maxLength, type: "string" }
    : {
        description: `At most ${maxLength} code points after conversion (trimmed and normalized, Contracts 5.5).`,
        type: "string",
      };
};

const ONLY_NULL: JsonObject = { type: "null" };

const choiceSchema = (field: MetaField, mode: ValueMode): JsonObject => {
  const choices = field.choices ?? [];

  if (mode === "read") {
    // A stored key stays readable after its choice is hidden or deleted.
    return nullable({
      description:
        "A choice key; `x-std-choices` lists the table's keys. A key whose choice was deleted after it was stored is still returned.",
      pattern: CHOICE_KEY,
      type: "string",
      "x-std-choices": choices.map((choice) => choice.key),
    });
  }

  const keys = choices.flatMap((choice) =>
    mode === "create" && choice.retired ? [] : [choice.key]
  );

  // No key can be written: only null (an empty `enum` is not valid JSON
  // Schema, and the server accepts null).
  if (keys.length === 0) {
    return ONLY_NULL;
  }

  const hidden = choices.some((choice) => choice.retired);

  const schema: JsonObject =
    mode === "update" && hidden
      ? {
          description:
            "Hidden (retired) keys are accepted only when they equal the stored value.",
          enum: keys,
          type: "string",
        }
      : { enum: keys, type: "string" };

  return nullable(schema);
};

const patterned = (pattern: string, extra: JsonObject = {}): JsonObject =>
  nullable({ ...extra, pattern, type: "string" });

const bigIntegerSchema = (read: boolean): JsonObject =>
  read
    ? patterned(BIG_INTEGER_OUT)
    : patterned(BIG_INTEGER_IN, {
        description:
          "Digits as a string, leading zeros allowed (at most 100 characters); the server checks the range and bounds.",
      });

const decimalSchema = (
  type: Extract<MetaFieldType, { readonly kind: "decimal" }>,
  read: boolean
): JsonObject => {
  const description = `decimal(${type.precision}, ${type.scale}) as a string`;

  return read
    ? patterned(decimalOut(type.scale), { description })
    : patterned(DECIMAL_IN, {
        description: `${description}; the server refuses values that are not exact at scale ${type.scale}, too many digits and values outside the bounds.`,
      });
};

const dateTimeSchema = (read: boolean): JsonObject =>
  read
    ? patterned(DATE_TIME_OUT, { format: "date-time" })
    : patterned(DATE_TIME_IN, {
        description:
          "RFC 3339 with Z or an offset; digits past the third fraction digit must be zero.",
        format: "date-time",
      });

const uuidSchema = (read: boolean): JsonObject =>
  patterned(read ? UUID_OUT : UUID_IN, { format: "uuid" });

const writeOnlySchema = (read: boolean): JsonObject =>
  read
    ? {
        properties: { set: { type: "boolean" } },
        required: ["set"],
        type: "object",
      }
    : nullable({ type: "string", writeOnly: true });

const valueSchema = (field: MetaField, mode: ValueMode): JsonObject => {
  const { type } = field;
  const read = mode === "read";

  switch (type.kind) {
    case "text":
    case "longText": {
      return nullable(textSchema(type.maxLength, mode));
    }

    case "integer": {
      return nullable({ type: "integer", ...boundsOf(type) });
    }

    case "bigInteger": {
      return bigIntegerSchema(read);
    }

    case "decimal": {
      return decimalSchema(type, read);
    }

    case "boolean": {
      return { type: "boolean" };
    }

    case "date": {
      return patterned(DATE, { format: "date" });
    }

    case "dateTime": {
      return dateTimeSchema(read);
    }

    case "choice": {
      return choiceSchema(field, mode);
    }

    case "reference":
    case "uuid": {
      return uuidSchema(read);
    }

    case "password":
    case "secret": {
      return writeOnlySchema(read);
    }

    case "json": {
      return {};
    }

    case "condition": {
      return nullable({ type: "object" });
    }

    default: {
      return type satisfies never;
    }
  }
};

/**
 * An object with optional members: those whose value is undefined are left
 * out.
 *
 * @param base - The members always present.
 * @param optional - Members present only with a value.
 * @returns The object.
 */
const withOptional = (
  base: JsonObject,
  optional: readonly (readonly [string, JsonValue | undefined])[]
): JsonObject =>
  Object.fromEntries([
    ...Object.entries(base),
    ...optional.flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value] as const]
    ),
  ]);

const described = (
  field: MetaField,
  schema: JsonObject,
  mode: ValueMode
): JsonObject => {
  const titled = withOptional({ ...schema, title: field.label }, [
    ["description", field.helpText ?? undefined],
    ["readOnly", field.readOnly ? true : undefined],
  ]);

  return mode === "read"
    ? titled
    : { ...titled, "x-std-write": field.write[mode] };
};

// The audit fields are values of every record (Contracts 2.1, 6.6).
const AUDIT_VALUES: JsonObject = {
  created_at: { format: "date-time", readOnly: true, type: "string" },
  created_by: { format: "uuid", readOnly: true, type: "string" },
  updated_at: { format: "date-time", readOnly: true, type: "string" },
  updated_by: { format: "uuid", readOnly: true, type: "string" },
};

// A followed reference's value appears under its dotted path (6.6).
const PATH_MEMBERS: JsonObject = {
  "^[^.]+\\.[^.]+$": {
    description:
      "A one-hop reference path selected with `fields` (`docked_to.name`): the target field's value, or null.",
  },
};

const valuesSchema = (
  fields: readonly MetaField[],
  mode: ValueMode
): JsonObject => {
  const properties: JsonObject = Object.fromEntries(
    fields.map((field) => [
      field.name,
      described(field, valueSchema(field, mode), mode),
    ])
  );

  return mode === "read"
    ? {
        additionalProperties: false,
        patternProperties: PATH_MEMBERS,
        properties: { ...properties, ...AUDIT_VALUES },
        type: "object",
      }
    : {
        // Fields the caller may write but not read are accepted by the
        // server (Contracts 3.4) and never named here (6.3).
        additionalProperties: true,
        description:
          "Field values by name. Fields the caller may write but not read are accepted and not listed.",
        properties,
        type: "object",
      };
};

const ref = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

const json = (schema: JsonObject): JsonObject => ({
  content: { "application/json": { schema } },
});

const ok = (description: string, schema: JsonObject): JsonObject => ({
  ...json(schema),
  description,
});

const parameter = (name: string, location: "path" | "query"): JsonObject => ({
  in: location,
  name,
  required: location === "path",
  schema: { type: "string" },
});

const ERROR = ok("A tagged API error (Contracts 3.8).", {
  properties: { _tag: { type: "string" } },
  required: ["_tag"],
  type: "object",
});

const errors: JsonObject = {
  "400": ERROR,
  "401": ERROR,
  "403": ERROR,
  "404": ERROR,
  "409": ERROR,
  "422": ERROR,
  "428": ERROR,
};

const IF_MATCH: JsonObject = {
  description: 'The version the change is based on, as `"<version>"`.',
  in: "header",
  name: "If-Match",
  required: true,
  schema: { type: "string" },
};

const LIST_QUERY = [
  "filter",
  "sort",
  "fields",
  "cursor",
  "limit",
  "count",
  "labels",
].map((name) => parameter(name, "query"));

const recordSchema: JsonObject = {
  properties: {
    class: { type: "string" },
    id: { format: "uuid", type: "string" },
    labels: { additionalProperties: { type: "string" }, type: "object" },
    values: ref("Values"),
    version: { type: "integer" },
    withheld: { items: { type: "string" }, type: "array" },
  },
  required: ["id", "class", "version", "values"],
  type: "object",
};

const paths = (table: MetaTable): JsonObject => {
  const base = `/api/v1/tables/${table.name}/records`;
  const id = parameter("id", "path");
  const read = { record: ref("Record"), schemaRevision: { type: "integer" } };

  // After a write, a record the caller can no longer see is only its ID
  // and version (Contracts 3.9).
  const saved = {
    record: {
      anyOf: [
        ref("Record"),
        {
          additionalProperties: false,
          properties: {
            id: { format: "uuid", type: "string" },
            version: { type: "integer" },
          },
          required: ["id", "version"],
          type: "object",
        },
      ],
    },
    schemaRevision: { type: "integer" },
  };

  const create: JsonObject = {
    operationId: "create",
    requestBody: json(ref("CreateBody")),
    responses: {
      "201": ok("The created record.", { properties: saved, type: "object" }),
      ...errors,
    },
  };

  const collection = withOptional(
    {
      get: {
        operationId: "list",
        parameters: LIST_QUERY,
        responses: {
          "200": ok("A page of records.", {
            properties: {
              count: { type: "integer" },
              nextCursor: { type: ["string", "null"] },
              records: { items: ref("Record"), type: "array" },
              schemaRevision: { type: "integer" },
            },
            type: "object",
          }),
          ...errors,
        },
      },
    },
    [["post", table.creatable ? create : undefined]]
  );

  return {
    [base]: collection,
    [`${base}/{id}`]: {
      delete: {
        operationId: "remove",
        parameters: [id, IF_MATCH],
        responses: {
          "200": ok("The delete's version.", {
            properties: {
              id: { type: "string" },
              schemaRevision: { type: "integer" },
              version: { type: "integer" },
            },
            type: "object",
          }),
          ...errors,
        },
      },
      get: {
        operationId: "get",
        parameters: [
          id,
          parameter("fields", "query"),
          parameter("labels", "query"),
        ],
        responses: {
          "200": ok("One record.", { properties: read, type: "object" }),
          ...errors,
        },
      },
      patch: {
        operationId: "update",
        parameters: [id, IF_MATCH],
        requestBody: json(ref("UpdateBody")),
        responses: {
          "200": ok("The updated record.", {
            properties: saved,
            type: "object",
          }),
          ...errors,
        },
      },
    },
    [`${base}/{id}/history`]: {
      get: {
        operationId: "history",
        parameters: [
          id,
          ...["since", "until", "actor", "kind", "field"].map((name) =>
            parameter(name, "query")
          ),
        ],
        responses: {
          "200": ok("The record's history the caller may read.", {
            type: "object",
          }),
          ...errors,
        },
      },
    },
  };
};

/**
 * The OpenAPI 3.1 document of one table for the caller.
 *
 * @param table - The caller's metadata of the table.
 * @param revision - The revision it was served at.
 * @returns The document.
 */
export const tableOpenApi = (
  table: MetaTable,
  revision: DocumentRevision
): JsonObject => {
  const info = withOptional(
    { title: `${table.label} (${table.name})`, version: revision.header },
    [["description", table.helpText ?? undefined]]
  );

  return {
    components: {
      schemas: {
        CreateBody: valuesSchema(table.fields, "create"),
        Record: recordSchema,
        UpdateBody: valuesSchema(table.fields, "update"),
        Values: valuesSchema(table.fields, "read"),
      },
    },
    info,
    openapi: "3.1.0",
    paths: paths(table),
    "x-std-schema-revision": revision.revision,
    "x-std-table": table.name,
  };
};
