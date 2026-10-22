/**
 * `GET /api/v2/openapi.json` (Contracts 10.1): the OpenAPI 3.1 document of
 * the generic API v2. A table's own resource schema is at
 * `/api/v2/tableMetadata/{table}/schema.json` for the caller, because a
 * deployed server's tables are known only at run time (6.1); this document
 * describes the routes, the query parameters, the EntityRef, the
 * ChangeEntry and every error subtype, which TMF `Error`s name in
 * `@schemaLocation` (`#/components/schemas/<_tag>`, Contracts 10.6).
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";

import { TMF_ERROR_TAGS } from "./tmf-error.ts";

const ref = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

const json = (schema: JsonObject): JsonObject => ({
  content: { "application/json": { schema } },
});

const errorResponses: JsonObject = {
  default: { description: "A TMF Error", ...json(ref("Error")) },
};

const query = (name: string, description: string): JsonObject => ({
  description,
  in: "query",
  name,
  required: false,
  schema: { type: "string" },
});

const path = (name: string): JsonObject => ({
  in: "path",
  name,
  required: true,
  schema: { type: "string" },
});

const ifMatch: JsonObject = {
  description: 'The revision the change is based on: "<revision>"',
  in: "header",
  name: "If-Match",
  required: true,
  schema: { type: "string" },
};

const LIST_PARAMETERS: readonly JsonObject[] = [
  path("table"),
  query("fields", "Attributes and one-hop paths; none; !name excludes"),
  query("sort", "Attribute names, - descending, + ascending"),
  query("offset", "Records to skip"),
  query("limit", "1 to 1000, default 100"),
  query("after", "A cursor: the page after it"),
  query("before", "A cursor: the page before it"),
  query("condition", "STD's condition text syntax with API names"),
  query("count", "false drops X-Total-Count on cursor pages"),
];

const resource: JsonObject = {
  additionalProperties: true,
  properties: {
    "@baseType": { type: "string" },
    "@schemaLocation": { format: "uri", type: "string" },
    "@type": { type: "string" },
    href: { format: "uri", type: "string" },
    id: { type: "string" },
    revision: { type: "integer" },
    withheld: { items: { type: "string" }, type: "array" },
  },
  required: ["id", "href", "@type"],
  type: "object",
};

const errorSchema: JsonObject = {
  properties: {
    "@baseType": { type: "string" },
    "@schemaLocation": { type: "string" },
    "@type": { type: "string" },
    code: { type: "string" },
    message: { type: "string" },
    reason: { type: "string" },
    referenceError: { format: "uri", type: "string" },
    status: { type: "string" },
  },
  required: ["code", "reason", "@type"],
  type: "object",
};

const errorSubtypes: readonly [string, JsonValue][] = TMF_ERROR_TAGS.map(
  (tag): [string, JsonValue] => [
    tag,
    {
      allOf: [ref("Error")],
      properties: { "@type": { const: tag }, code: { const: tag } },
    },
  ]
);

/** The document. */
export const v2OpenApi: JsonObject = {
  components: {
    schemas: {
      ChangeEntry: {
        properties: {
          "@baseType": { const: "History" },
          "@type": { const: "ChangeEntry" },
          action: { enum: ["created", "updated", "deleted"] },
          actor: ref("EntityRef"),
          changes: { type: "object" },
          creationDate: { format: "date-time", type: "string" },
          fields: { type: "object" },
          id: { type: "string" },
          kind: { enum: ["create", "update", "delete"] },
          revision: { type: "integer" },
        },
        type: "object",
      },
      EntityRef: {
        properties: {
          "@referredType": { type: "string" },
          "@type": { const: "EntityRef" },
          href: { format: "uri", type: "string" },
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      Error: errorSchema,
      Resource: resource,
      ...Object.fromEntries(errorSubtypes),
    },
  },
  info: {
    description:
      "STD's generic API under TMF630 (Contracts 10). Tables are collections named by their v2 names; each table's resource schema is at /api/v2/tableMetadata/{table}/schema.json.",
    title: "STD API",
    version: "2",
  },
  openapi: "3.1.0",
  paths: {
    "/api/v2/session": {
      post: {
        responses: { "201": { description: "Signed in" }, ...errorResponses },
      },
    },
    "/api/v2/session/current": {
      delete: {
        responses: { "204": { description: "Signed out" }, ...errorResponses },
      },
      get: {
        responses: { "200": { description: "The session" }, ...errorResponses },
      },
    },
    "/api/v2/tableMetadata": {
      get: {
        responses: { "200": { description: "The tables" }, ...errorResponses },
      },
    },
    "/api/v2/tableMetadata/{table}": {
      get: {
        parameters: [path("table")],
        responses: {
          "200": { description: "The metadata" },
          ...errorResponses,
        },
      },
    },
    "/api/v2/tableMetadata/{table}/schema.json": {
      get: {
        parameters: [path("table")],
        responses: {
          "200": { description: "The JSON Schema" },
          ...errorResponses,
        },
      },
    },
    "/api/v2/{table}": {
      get: {
        parameters: [...LIST_PARAMETERS],
        responses: {
          "200": {
            description: "The page",
            ...json({ items: ref("Resource"), type: "array" }),
          },
          ...errorResponses,
        },
      },
      post: {
        parameters: [path("table")],
        requestBody: json(ref("Resource")),
        responses: {
          "201": { description: "Created", ...json(ref("Resource")) },
          ...errorResponses,
        },
      },
    },
    "/api/v2/{table}/{id}": {
      delete: {
        parameters: [path("table"), path("id"), ifMatch],
        responses: { "204": { description: "Deleted" }, ...errorResponses },
      },
      get: {
        parameters: [path("table"), path("id"), query("fields", "Selection")],
        responses: {
          "200": { description: "The resource", ...json(ref("Resource")) },
          ...errorResponses,
        },
      },
      patch: {
        parameters: [path("table"), path("id"), ifMatch],
        requestBody: {
          content: {
            "application/json-patch+json": { schema: { type: "array" } },
            "application/merge-patch+json": { schema: ref("Resource") },
          },
        },
        responses: {
          "200": { description: "Updated", ...json(ref("Resource")) },
          ...errorResponses,
        },
      },
    },
    "/api/v2/{table}/{id}/history": {
      get: {
        parameters: [path("table"), path("id")],
        responses: {
          "200": {
            description: "The entries",
            ...json({ items: ref("ChangeEntry"), type: "array" }),
          },
          ...errorResponses,
        },
      },
    },
  },
};
