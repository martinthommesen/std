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
 * - A create body may name active choice keys; an update body also the
 *   hidden ones, which the server keeps only when unchanged (6.5).
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

const BIG_INTEGER = "^-?(0|[1-9][0-9]*)$";

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

const choiceSchema = (field: MetaField, mode: ValueMode): JsonObject => {
  const choices = field.choices ?? [];

  const keys = choices.flatMap((choice) =>
    mode === "create" && choice.retired ? [] : [choice.key]
  );

  const hidden = choices.some((choice) => choice.retired);

  return mode === "update" && hidden
    ? {
        description:
          "Hidden (retired) keys are accepted only when they equal the stored value.",
        enum: keys,
        type: "string",
      }
    : { enum: keys, type: "string" };
};

const valueSchema = (field: MetaField, mode: ValueMode): JsonObject => {
  const { type } = field;

  switch (type.kind) {
    case "text":
    case "longText": {
      return nullable(textSchema(type.maxLength, mode));
    }

    case "integer": {
      return nullable({ type: "integer", ...boundsOf(type) });
    }

    case "bigInteger": {
      return nullable({ pattern: BIG_INTEGER, type: "string" });
    }

    case "decimal": {
      return nullable({
        description: `decimal(${type.precision}, ${type.scale}) as a string`,
        type: "string",
      });
    }

    case "boolean": {
      return { type: "boolean" };
    }

    case "date": {
      return nullable({ format: "date", type: "string" });
    }

    case "dateTime": {
      return nullable({ format: "date-time", type: "string" });
    }

    case "choice": {
      return nullable(choiceSchema(field, mode));
    }

    case "reference":
    case "uuid": {
      return nullable({ format: "uuid", type: "string" });
    }

    case "password":
    case "secret": {
      return mode === "read"
        ? {
            properties: { set: { type: "boolean" } },
            required: ["set"],
            type: "object",
          }
        : nullable({ type: "string", writeOnly: true });
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
    : { additionalProperties: false, properties, type: "object" };
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
