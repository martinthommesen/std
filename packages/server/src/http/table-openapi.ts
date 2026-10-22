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
 * written, choices the keys of the table's choices (active ones on writes).
 * A field the caller can never write on a route is left out of that
 * route's body.
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

const valueSchema = (field: MetaField, mode: "read" | "write"): JsonObject => {
  const { type } = field;

  switch (type.kind) {
    case "text":
    case "longText": {
      return nullable(
        type.maxLength === undefined
          ? { type: "string" }
          : { maxLength: type.maxLength, type: "string" }
      );
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
      const keys = (field.choices ?? []).flatMap((choice) =>
        mode === "write" && choice.retired ? [] : [choice.key]
      );

      return nullable({ enum: keys, type: "string" });
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

const described = (field: MetaField, schema: JsonObject): JsonObject =>
  withOptional({ ...schema, title: field.label }, [
    ["description", field.helpText ?? undefined],
    ["readOnly", field.readOnly ? true : undefined],
  ]);

const valuesSchema = (
  fields: readonly MetaField[],
  mode: "read" | "write"
): JsonObject => ({
  additionalProperties: false,
  properties: Object.fromEntries(
    fields.map((field) => [
      field.name,
      described(field, valueSchema(field, mode)),
    ])
  ),
  type: "object",
});

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

const bodyFields = (
  table: MetaTable,
  action: "create" | "update"
): readonly MetaField[] =>
  table.fields.filter((field) => field.write[action] !== "no");

const paths = (table: MetaTable): JsonObject => {
  const base = `/api/v1/tables/${table.name}/records`;
  const id = parameter("id", "path");
  const saved = { record: ref("Record"), schemaRevision: { type: "integer" } };

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
          "200": ok("One record.", { properties: saved, type: "object" }),
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
        CreateBody: valuesSchema(bodyFields(table, "create"), "write"),
        Record: recordSchema,
        UpdateBody: valuesSchema(bodyFields(table, "update"), "write"),
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
