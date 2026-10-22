/**
 * The resource schemas of `/api/v2` (Contracts 10.2 to 10.4), with separate
 * request and response forms: a response carries the read-only `id` and
 * `href`, which the server refuses in a request.
 */
import { Schema } from "effect";

const extensionMembers = Schema.Record(Schema.String, Schema.Json);

/** A reference to another resource. */
export const EntityRef = Schema.Struct({
  "@referredType": Schema.optionalKey(Schema.String),
  "@type": Schema.optionalKey(Schema.String),
  href: Schema.optionalKey(Schema.String),
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "EntityRef" });

/**
 * A resource as the server answers: flat, with `id`, `href` and `@type`,
 * and the table's own attributes as further members (their schema is at
 * `/api/v2/tableMetadata/{table}/schema.json`).
 */
export const Resource = Schema.StructWithRest(
  Schema.Struct({
    "@baseType": Schema.optionalKey(Schema.String),
    "@schemaLocation": Schema.optionalKey(Schema.String),
    "@type": Schema.String,
    href: Schema.String,
    id: Schema.String,
    revision: Schema.optionalKey(Schema.Int),
    withheld: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [extensionMembers]
).annotate({ identifier: "Resource" });

/**
 * The request body of a create: the table's attributes, and optionally
 * `@type` to create a subclass. `id`, `href`, `revision` and the audit
 * attributes are read-only and refused.
 */
export const ResourceCreate = Schema.StructWithRest(
  Schema.Struct({
    "@baseType": Schema.optionalKey(Schema.String),
    "@schemaLocation": Schema.optionalKey(Schema.String),
    "@type": Schema.optionalKey(Schema.String),
  }),
  [extensionMembers]
).annotate({ identifier: "ResourceCreate" });

/**
 * The request body of an RFC 7396 merge patch: the attributes to change,
 * every member optional; `null` removes an attribute.
 */
export const ResourcePatch = Schema.StructWithRest(
  Schema.Struct({
    "@baseType": Schema.optionalKey(Schema.String),
    "@schemaLocation": Schema.optionalKey(Schema.String),
    "@type": Schema.optionalKey(Schema.String),
  }),
  [extensionMembers]
).annotate({ identifier: "ResourcePatch" });

/** One RFC 6902 operation of an `application/json-patch+json` body. */
export const JsonPatchOperation = Schema.Struct({
  from: Schema.optionalKey(Schema.String),
  op: Schema.Literals(["add", "remove", "replace", "move", "copy", "test"]),
  path: Schema.String,
  value: Schema.optionalKey(Schema.Json),
}).annotate({ identifier: "JsonPatchOperation" });

/** One entry of a record's history. */
export const ChangeEntry = Schema.StructWithRest(
  Schema.Struct({
    "@baseType": Schema.Literal("History"),
    "@type": Schema.Literal("ChangeEntry"),
    action: Schema.String,
    actor: Schema.optionalKey(EntityRef),
    changes: Schema.optionalKey(Schema.Json),
    creationDate: Schema.optionalKey(Schema.Json),
    fields: Schema.optionalKey(Schema.Json),
    id: Schema.String,
    kind: Schema.String,
    revision: Schema.optionalKey(Schema.Json),
  }),
  [extensionMembers]
).annotate({ identifier: "ChangeEntry" });
