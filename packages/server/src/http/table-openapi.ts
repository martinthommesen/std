/**
 * The per-table OpenAPI 3.1 document (Contracts 6.1, 6.3): the record
 * routes of one table on `/api/v1` (list, create, get, patch, delete and
 * history), with the table's resource described from the caller's
 * metadata, so it shows exactly the attributes the metadata shows and
 * nothing else. It states the schema revision it describes: `info.version`
 * is `<revision>.<change_set_id>` (the `STD-Schema-Revision` form) and
 * `x-std-schema-revision` the number. The error responses and their
 * schemas are those of `GET /api/v1/openapi.json`.
 *
 * Attributes are named by API name (`purchasedOn`). Value schemas follow
 * Contracts 6.5: big integers and decimals are strings, date-times
 * RFC 3339, UUIDs lowercase, password and secret values `{"set": bool}`
 * when read and plaintext when written, choices the keys of the table's
 * choices. A reference is the typed reference (`<Type>Ref`) or the generic
 * `EntityRef` the server answers with; a write takes the ID or an
 * EntityRef whose `id` is the ID.
 *
 * The document never refuses traffic the server accepts; where JSON Schema
 * cannot say what the server checks, it says less and describes the rest:
 *
 * - A resource holds the attributes the caller can read, the system
 *   attributes and, through a parent collection, the attributes of the
 *   record's concrete class; empty attributes are left out, never null.
 *   A reference may also carry the members of a path selected with
 *   `fields` (`dockedTo.name`).
 * - Read schemas describe each type's canonical output (`encodeOut`), write
 *   schemas the input its codec accepts (`decodeIn`): big integers with
 *   leading zeros, decimals at any scale, date-times with offsets, UUIDs in
 *   any case. What a pattern cannot say (ranges, calendar validity, scale)
 *   is described and left to the server.
 * - A create body may name active choice keys; a patch body also the
 *   hidden ones, which the server keeps only when unchanged (6.5). A
 *   choice attribute with no writable key accepts only null. Read values
 *   accept any key, since a stored key outlives its choice's deletion.
 * - Write bodies accept members they do not list: the server accepts
 *   attributes the caller may write but not read (3.4), and the document
 *   never names an attribute the caller cannot read.
 * - Write bodies name every attribute the caller can read except the
 *   read-only ones: forms send whole records, and an unchanged attribute
 *   the caller may not write is accepted (3.9). `x-std-write` states
 *   whether the caller may write it (`yes`, `no`, `perRecord`).
 * - Text lengths bound read values; written text is converted first
 *   (trimmed, normalized, Contracts 5.5), so its limit is described, not
 *   enforced.
 */
import { ListQuery } from "@std/api/records";
import { apiAttributeNameOf } from "@std/definitions/names";
import type {
  MetaField,
  MetaFieldType,
  MetaTable,
} from "@std/definitions/table-metadata";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";

import { apiOpenApi } from "./api/openapi.ts";
import { API_PREFIX } from "./api/resource.ts";
import { DEFINITION_KIND_OF_TABLE } from "./change-sets.ts";

/** How the document describes the revision it was served at. */
export interface DocumentRevision {
  readonly revision: number;
  /** `<revision>.<change_set_id>`. */
  readonly header: string;
}

/** The reference types the caller sees (as `schema.json` shows them). */
export interface DocumentRefs {
  /** The `@type` of a reference to a table, `EntityRef` for null. */
  readonly typeOf: (target: string | null) => string;
  /** The `@type` of `createdBy` and `updatedBy`. */
  readonly user: string;
}

/** How the table is named on the API. */
export interface DocumentNaming {
  /** The collection (`acmeAsset`). */
  readonly collection: string;
  /** The resource `@type` (`AcmeAsset`). */
  readonly type: string;
  readonly refs: DocumentRefs;
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

/** Which values a schema describes: a read, or a create or patch body. */
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

// The non-null schema of a choice value, or undefined when no key can be
// written (the server accepts only null then; an empty `enum` is invalid).
const choiceSchema = (
  field: MetaField,
  mode: ValueMode
): JsonObject | undefined => {
  const choices = field.choices ?? [];

  if (mode === "read") {
    // A stored key stays readable after its choice is hidden or deleted.
    return {
      description:
        "A choice key; `x-std-choices` lists the table's keys. A key whose choice was deleted after it was stored is still returned.",
      pattern: CHOICE_KEY,
      type: "string",
      "x-std-choices": choices.map((choice) => choice.key),
    };
  }

  const keys = choices.flatMap((choice) =>
    mode === "create" && choice.retired ? [] : [choice.key]
  );

  if (keys.length === 0) {
    return undefined;
  }

  return mode === "update" && choices.some((choice) => choice.retired)
    ? {
        description:
          "Hidden (retired) keys are accepted only when they equal the stored value.",
        enum: keys,
        type: "string",
      }
    : { enum: keys, type: "string" };
};

const patterned = (pattern: string, extra: JsonObject = {}): JsonObject => ({
  ...extra,
  pattern,
  type: "string",
});

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

const componentRef = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

// A reference: read as the typed reference the server answers with, written
// as its ID or an EntityRef carrying it.
const referenceSchema = (
  type: Extract<MetaFieldType, { readonly kind: "reference" }>,
  read: boolean,
  refs: DocumentRefs
): JsonObject =>
  read
    ? componentRef(refs.typeOf(type.target))
    : {
        anyOf: [
          uuidSchema(false),
          {
            description:
              "An EntityRef: only `id` is read; a `@referredType` must name the target class or a descendant.",
            properties: { id: uuidSchema(false) },
            required: ["id"],
            type: "object",
          },
        ],
      };

const writeOnlySchema = (read: boolean): JsonObject =>
  read
    ? {
        properties: { set: { type: "boolean" } },
        required: ["set"],
        type: "object",
      }
    : { type: "string", writeOnly: true };

// The schema of a value that is present.
const presentSchema = (
  field: MetaField,
  mode: ValueMode,
  refs: DocumentRefs
): JsonObject | undefined => {
  const { type } = field;
  const read = mode === "read";

  switch (type.kind) {
    case "text":
    case "longText": {
      return textSchema(type.maxLength, mode);
    }

    case "integer": {
      return { type: "integer", ...boundsOf(type) };
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

    case "reference": {
      return referenceSchema(type, read, refs);
    }

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
      return { type: "object" };
    }

    default: {
      return type satisfies never;
    }
  }
};

// Reads leave empty attributes out; writes take null to clear one.
const valueSchema = (
  field: MetaField,
  mode: ValueMode,
  refs: DocumentRefs
): JsonObject => {
  const present = presentSchema(field, mode, refs);

  if (present === undefined) {
    return ONLY_NULL;
  }

  return mode === "read" || field.type.kind === "boolean"
    ? present
    : nullable(present);
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

// The attributes the caller can read (the metadata's fields).
const readable = (table: MetaTable): readonly MetaField[] =>
  table.fields.filter((field) => field.read !== "no");

// What a request body may name: read-only attributes are left out.
const writable = (table: MetaTable): readonly MetaField[] =>
  readable(table).filter((field) => !field.readOnly);

const attributesOf = (
  fields: readonly MetaField[],
  mode: ValueMode,
  refs: DocumentRefs
): JsonObject =>
  Object.fromEntries(
    fields.map((field) => [
      apiAttributeNameOf(field.name),
      described(field, valueSchema(field, mode, refs), mode),
    ])
  );

const STRING: JsonObject = { type: "string" };

// The system attributes of every resource (Contracts 10.2).
const systemAttributes = (refs: DocumentRefs): JsonObject => ({
  "@baseType": STRING,
  "@schemaLocation": { format: "uri", type: "string" },
  "@type": STRING,
  createdBy: componentRef(refs.user),
  creationDate: { format: "date-time", readOnly: true, type: "string" },
  href: { format: "uri", type: "string" },
  id: STRING,
  lastUpdate: { format: "date-time", readOnly: true, type: "string" },
  revision: { type: "integer" },
  updatedBy: componentRef(refs.user),
  withheld: {
    description:
      "Attributes the caller may not read on this record (conditionally hidden).",
    items: STRING,
    type: "array",
  },
});

const resourceSchema = (
  table: MetaTable,
  naming: DocumentNaming
): JsonObject => ({
  // Through a parent collection a record shows its concrete class's
  // attributes, which this table's metadata does not list.
  additionalProperties: true,
  properties: {
    ...systemAttributes(naming.refs),
    ...attributesOf(readable(table), "read", naming.refs),
  },
  required: ["id", "href", "@type"],
  title: naming.type,
  type: "object",
});

const bodySchema = (
  table: MetaTable,
  mode: "create" | "update",
  refs: DocumentRefs
): JsonObject => ({
  // Attributes the caller may write but not read are accepted by the
  // server (Contracts 3.4) and never named here (6.3).
  additionalProperties: true,
  description:
    mode === "create"
      ? "Attributes by API name; `@type` creates a subclass through the parent collection. Attributes the caller may write but not read are accepted and not listed."
      : "A merge patch (RFC 7396): attributes by API name, `null` clears one. Attributes the caller may write but not read are accepted and not listed.",
  properties: {
    "@baseType": STRING,
    "@schemaLocation": STRING,
    "@type": STRING,
    ...attributesOf(writable(table), mode, refs),
  },
  type: "object",
});

// One reference type's definition: an EntityRef whose `@type` is fixed; a
// path selected with `fields` adds members.
const refDefinition = (refType: string): JsonObject => ({
  additionalProperties: true,
  properties: {
    "@referredType": STRING,
    "@type": { const: refType },
    href: { format: "uri", type: "string" },
    id: STRING,
    name: STRING,
  },
  required: ["id"],
  type: "object",
});

const referenceSchemas = (table: MetaTable, refs: DocumentRefs): JsonObject => {
  const used = new Set([
    "EntityRef",
    refs.user,
    ...readable(table).flatMap((field) =>
      field.type.kind === "reference" ? [refs.typeOf(field.type.target)] : []
    ),
  ]);

  return Object.fromEntries(
    [...used].toSorted().map((refType) => [refType, refDefinition(refType)])
  );
};

const JSON_PATCH: JsonObject = {
  items: {
    properties: {
      from: STRING,
      op: {
        enum: ["add", "remove", "replace", "move", "copy", "test"],
        type: "string",
      },
      path: STRING,
      value: {},
    },
    required: ["op", "path"],
    type: "object",
  },
  type: "array",
};

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
  schema: STRING,
});

const IF_MATCH: JsonObject = {
  description: 'The revision the change is based on, as `"<revision>"`.',
  in: "header",
  name: "If-Match",
  required: true,
  schema: STRING,
};

const LIST_NOTE =
  'A page of resources. Besides the named parameters, any attribute name filters by equality (`status=spare`), with the operator forms of Contracts 10.3. `fields` selects attributes and one-hop paths, `sort` lists attribute names (`-` descending), `condition` takes STD\'s condition text with API names, `allowedFor=<collection>/<attribute>` narrows to what a reference attribute may point at. `X-Total-Count` carries the total; the next page is the `Link` header with `rel="next"`.';

const LIST_QUERY = Object.keys(ListQuery).map((name) =>
  parameter(name, "query")
);

const OPERATION_IDS = [
  "list",
  "create",
  "get",
  "patch",
  "delete",
  "history",
] as const;

type OperationId = (typeof OPERATION_IDS)[number];

// The API-wide operations the per-table paths take their error responses
// from, by operation ID.
const operationsById = (): ReadonlyMap<string, JsonObject> => {
  const found = new Map<string, JsonObject>();
  const paths = apiOpenApi.paths ?? null;

  for (const item of isJsonObject(paths) ? Object.values(paths) : []) {
    for (const operation of isJsonObject(item) ? Object.values(item) : []) {
      const id = isJsonObject(operation) ? operation.operationId : undefined;

      if (isJsonObject(operation) && id !== undefined && isJsonString(id)) {
        found.set(id, operation);
      }
    }
  }

  return found;
};

// The responses of an operation with a 4xx or 5xx status.
const errorResponsesOf = (operationId: OperationId): JsonObject => {
  const responses =
    operationsById().get(`records.${operationId}`)?.responses ?? null;

  return isJsonObject(responses)
    ? Object.fromEntries(
        Object.entries(responses).filter(([status]) => Number(status) >= 400)
      )
    : {};
};

const COMPONENT_PREFIX = "#/components/schemas/";

// A component schema of the API-wide document.
const apiSchema = (name: string): JsonValue | undefined => {
  const components = apiOpenApi.components ?? null;

  const schemas = isJsonObject(components)
    ? (components.schemas ?? null)
    : null;

  return isJsonObject(schemas) ? schemas[name] : undefined;
};

// Every component schema a value references, transitively through the
// API-wide components.
const referencedSchemas = (
  value: JsonValue,
  found: Map<string, JsonValue>
): void => {
  if (isJsonArray(value)) {
    for (const item of value) {
      referencedSchemas(item, found);
    }

    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  const ref = value.$ref ?? null;

  if (isJsonString(ref) && ref.startsWith(COMPONENT_PREFIX)) {
    const name = ref.slice(COMPONENT_PREFIX.length);
    const schema = apiSchema(name);

    if (schema !== undefined && !found.has(name)) {
      found.set(name, schema);
      referencedSchemas(schema, found);
    }
  }

  for (const member of Object.values(value)) {
    referencedSchemas(member, found);
  }
};

const operationOf = (
  operationId: OperationId,
  base: JsonObject,
  success: JsonObject
): JsonObject => ({
  ...base,
  operationId,
  responses: { ...success, ...errorResponsesOf(operationId) },
});

/**
 * The media types a `PATCH` takes: a merge patch, and a JSON Patch except
 * on a definition table, whose writes are change sets (Contracts 10.5).
 *
 * @param definitionTable - Whether the table holds definitions.
 * @returns The request body's content.
 */
const patchContent = (definitionTable: boolean): JsonObject => {
  const merge = { schema: componentRef("ResourcePatch") };

  return definitionTable
    ? { "application/json": merge, "application/merge-patch+json": merge }
    : {
        "application/json": merge,
        "application/json-patch+json": { schema: componentRef("JsonPatch") },
        "application/merge-patch+json": merge,
      };
};

const paths = (table: MetaTable, naming: DocumentNaming): JsonObject => {
  const base = `${API_PREFIX}/${naming.collection}`;
  const definitionTable = DEFINITION_KIND_OF_TABLE.has(table.name);
  const id = parameter("id", "path");
  const resource = componentRef("Resource");

  const list = operationOf(
    "list",
    { description: LIST_NOTE, parameters: LIST_QUERY },
    { "200": ok("A page of resources.", { items: resource, type: "array" }) }
  );

  const create = operationOf(
    "create",
    {
      requestBody: { ...json(componentRef("ResourceCreate")), required: true },
    },
    { "201": ok("The created resource.", resource) }
  );

  return {
    [base]: withOptional({ get: list }, [
      ["post", table.creatable ? create : undefined],
    ]),
    [`${base}/{id}`]: {
      delete: operationOf(
        "delete",
        { parameters: [id, IF_MATCH] },
        { "204": { description: "Deleted; no body." } }
      ),
      get: operationOf(
        "get",
        { parameters: [id, parameter("fields", "query")] },
        { "200": ok("One resource.", resource) }
      ),
      patch: operationOf(
        "patch",
        {
          description: definitionTable
            ? "A merge patch (`application/merge-patch+json`, or `application/json`): a definition table's write is a change set, so it takes no JSON Patch; `If-Match` carries the revision the change is based on."
            : "A merge patch (`application/merge-patch+json`, or `application/json`) or an RFC 6902 operation list (`application/json-patch+json`); `If-Match` carries the revision the change is based on.",
          parameters: [id, IF_MATCH],
          requestBody: {
            content: patchContent(definitionTable),
            required: true,
          },
        },
        { "200": ok("The updated resource.", resource) }
      ),
    },
    [`${base}/{id}/history`]: {
      get: operationOf(
        "history",
        {
          parameters: [
            id,
            ...[
              "since",
              "until",
              "actor",
              "kind",
              "field",
              "fields",
              "offset",
              "limit",
            ].map((name) => parameter(name, "query")),
          ],
        },
        {
          "200": ok("The record's history the caller may read.", {
            items: componentRef("ChangeEntry"),
            type: "array",
          }),
        }
      ),
    },
  };
};

/**
 * The OpenAPI 3.1 document of one table for the caller.
 *
 * @param table - The caller's metadata of the table.
 * @param revision - The revision it was served at.
 * @param naming - The table's collection, type and reference types.
 * @returns The document.
 */
export const tableOpenApi = (
  table: MetaTable,
  revision: DocumentRevision,
  naming: DocumentNaming
): JsonObject => {
  const info = withOptional(
    {
      title: `${table.label} (${naming.collection})`,
      version: revision.header,
    },
    [["description", table.helpText ?? undefined]]
  );

  const apiSchemas = new Map<string, JsonValue>();

  // The error schemas (and the history entry) of the API-wide document.
  referencedSchemas(
    [
      componentRef("ChangeEntry"),
      ...OPERATION_IDS.map((operationId) => errorResponsesOf(operationId)),
    ],
    apiSchemas
  );

  // A JSON Patch body only where the table takes one (not a definition
  // table's change sets).
  if (!DEFINITION_KIND_OF_TABLE.has(table.name)) {
    apiSchemas.set("JsonPatch", JSON_PATCH);
  }

  return {
    components: {
      schemas: {
        ...Object.fromEntries(apiSchemas),
        ...referenceSchemas(table, naming.refs),
        Resource: resourceSchema(table, naming),
        ResourceCreate: bodySchema(table, "create", naming.refs),
        ResourcePatch: bodySchema(table, "update", naming.refs),
      },
    },
    info,
    openapi: "3.1.0",
    paths: paths(table, naming),
    "x-std-collection": naming.collection,
    "x-std-schema-revision": revision.revision,
    "x-std-table": table.name,
  };
};
