/**
 * The definition set file format (Contracts 1.8, 8.1, 8.3), after YAML
 * parsing.
 *
 * A set is a directory of YAML files. Exactly one file holds the `set`
 * header; every file may hold any of the definition lists. Each entry
 * carries its stable ID; entries refer to each other by name (qualified
 * table names such as `acme.asset`, field names, role and permission
 * names), resolved within the set and the sets it requires. Conditions
 * are JSON ASTs whose paths hold field IDs.
 *
 * ```yaml
 * set: { id: <uuid>, name: acme, layer: app, version: 1, requires: [core] }
 * namespaces:
 *   - { id: <uuid>, name: acme, label: Acme }
 * tables:
 *   - id: <uuid>
 *     name: acme.laptop
 *     extends: acme.asset
 *     displayField: name
 *     fields:
 *       - { id: <uuid>, name: serial, type: { kind: text, maxLength: 64 } }
 *       - { id: <uuid>, name: owner, type: { kind: reference, target: core.user } }
 *       - { id: <uuid>, name: due_when,
 *           type: { kind: condition, class: acme.asset, profile: filter } }
 *     overrides:
 *       - { id: <uuid>, field: purchased_on, required: true }
 *     indexes:
 *       - { id: <uuid>, fields: [serial], unique: true }
 * roles: [{ id: <uuid>, name: asset_manager, label: Asset manager }]
 * permissions: [{ id: <uuid>, name: schema.purge, label: Purge schema }]
 * grants: [{ id: <uuid>, role: schema_purger, permission: schema.purge }]
 * accessRules:
 *   - { id: <uuid>, effect: allow, roles: [admin], table: "*", target: records,
 *       actions: [read, create, update, delete] }
 * subscriptions: []
 * ```
 */
import {
  ConditionProfileSchema,
  FieldTypeSchema,
} from "@std/values/field-type";
import {
  Array as SchemaArray,
  Boolean as SchemaBoolean,
  Finite,
  Int,
  isGreaterThanOrEqualTo,
  Json,
  Literal,
  Literals,
  optionalKey,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import {
  AccessActionSchema,
  StorageSchema,
  SubscriptionOperationSchema,
} from "./definition.ts";
import { DefinitionIdSchema } from "./ids.ts";

/** The header of a set (`set:` in exactly one file). */
export const SetHeaderSchema = Struct({
  id: DefinitionIdSchema,
  layer: Literals(["core", "app"]),
  name: SchemaString,
  /** Default `protected` flag of every definition in the set. */
  protected: optionalKey(SchemaBoolean),
  /** Names of the sets this set's names may refer to. */
  requires: optionalKey(SchemaArray(SchemaString)),
  version: Int.check(isGreaterThanOrEqualTo(1)),
});

/** A set header. */
export type SetHeader = typeof SetHeaderSchema.Type;

const flags = {
  helpText: optionalKey(SchemaString),
  id: DefinitionIdSchema,
  label: optionalKey(SchemaString),
  protected: optionalKey(SchemaBoolean),
} as const;

/** A namespace entry. */
export const NamespaceEntrySchema = Struct({
  ...flags,
  extensible: optionalKey(SchemaBoolean),
  name: SchemaString,
  storage: optionalKey(StorageSchema),
});

/** Field kinds that need no settings, written as a bare kind name. */
export const SimpleKindSchema = Literals([
  "text",
  "longText",
  "integer",
  "bigInteger",
  "boolean",
  "date",
  "dateTime",
  "uuid",
  "password",
  "json",
]);

/** A reference type in a file names its target table. */
export const ReferenceEntrySchema = Struct({
  kind: Literal("reference"),
  target: SchemaString,
});

/**
 * A condition type in a file names the table whose fields its conditions
 * may name, and their profile.
 */
export const ConditionEntrySchema = Struct({
  class: SchemaString,
  kind: Literal("condition"),
  profile: ConditionProfileSchema,
});

/**
 * A field type in a file: a bare kind name, a reference naming its target
 * table, a condition naming its table, or any `@std/values` field type
 * object.
 */
export const TypeEntrySchema = Union([
  SimpleKindSchema,
  ReferenceEntrySchema,
  ConditionEntrySchema,
  FieldTypeSchema,
]);

/** A field type entry. */
export type TypeEntry = typeof TypeEntrySchema.Type;

/** A field entry. */
export const FieldEntrySchema = Struct({
  ...flags,
  default: optionalKey(Json),
  name: SchemaString,
  readOnly: optionalKey(SchemaBoolean),
  required: optionalKey(SchemaBoolean),
  type: TypeEntrySchema,
});

/** A field entry. */
export type FieldEntry = typeof FieldEntrySchema.Type;

const BoundEntry = Union([Finite, SchemaString]);

/** An override entry: tightens an inherited field, named by field name. */
export const OverrideEntrySchema = Struct({
  default: optionalKey(Json),
  field: SchemaString,
  helpText: optionalKey(SchemaString),
  id: DefinitionIdSchema,
  label: optionalKey(SchemaString),
  max: optionalKey(BoundEntry),
  maxLength: optionalKey(Int),
  min: optionalKey(BoundEntry),
  protected: optionalKey(SchemaBoolean),
  readOnly: optionalKey(SchemaBoolean),
  required: optionalKey(SchemaBoolean),
});

/** An override entry. */
export type OverrideEntry = typeof OverrideEntrySchema.Type;

/** An index entry, naming fields of its own table. */
export const IndexEntrySchema = Struct({
  fields: SchemaArray(SchemaString),
  id: DefinitionIdSchema,
  /** An optional name, unique per table. */
  name: optionalKey(SchemaString),
  protected: optionalKey(SchemaBoolean),
  unique: optionalKey(SchemaBoolean),
});

/** An index entry. */
export type IndexEntry = typeof IndexEntrySchema.Type;

/** A table entry with its fields, overrides and indexes. */
export const TableEntrySchema = Struct({
  ...flags,
  displayField: optionalKey(SchemaString),
  extends: optionalKey(SchemaString),
  extensible: optionalKey(SchemaBoolean),
  fields: optionalKey(SchemaArray(FieldEntrySchema)),
  indexes: optionalKey(SchemaArray(IndexEntrySchema)),
  /** The qualified name, `namespace.table`. */
  name: SchemaString,
  overrides: optionalKey(SchemaArray(OverrideEntrySchema)),
  storage: optionalKey(StorageSchema),
});

/** A table entry. */
export type TableEntry = typeof TableEntrySchema.Type;

/** A role or permission entry. */
export const NamedEntrySchema = Struct({ ...flags, name: SchemaString });

/** A grant entry. */
export const GrantEntrySchema = Struct({
  id: DefinitionIdSchema,
  permission: SchemaString,
  protected: optionalKey(SchemaBoolean),
  role: SchemaString,
});

/** An access-rule entry. */
export const AccessRuleEntrySchema = Struct({
  actions: SchemaArray(AccessActionSchema),
  active: optionalKey(SchemaBoolean),
  condition: optionalKey(ConditionSchema),
  description: optionalKey(SchemaString),
  effect: Literals(["allow", "deny"]),
  /** With `target: fields`: `"*"` or field names of the table or its ancestors. */
  fields: optionalKey(Union([Literal("*"), SchemaArray(SchemaString)])),
  id: DefinitionIdSchema,
  /** An optional name, unique among access rules. */
  name: optionalKey(SchemaString),
  protected: optionalKey(SchemaBoolean),
  roles: SchemaArray(SchemaString),
  /** A qualified table name, or `"*"` for every table. */
  table: SchemaString,
  target: Literals(["records", "fields"]),
});

/** An access-rule entry. */
export type AccessRuleEntry = typeof AccessRuleEntrySchema.Type;

/** A subscription entry. */
export const SubscriptionEntrySchema = Struct({
  condition: optionalKey(ConditionSchema),
  deadLetter: optionalKey(Literals(["block", "skip"])),
  enabled: optionalKey(SchemaBoolean),
  id: DefinitionIdSchema,
  identity: DefinitionIdSchema,
  maxAttempts: optionalKey(Int.check(isGreaterThanOrEqualTo(1))),
  name: SchemaString,
  operations: SchemaArray(SubscriptionOperationSchema),
  protected: optionalKey(SchemaBoolean),
  table: SchemaString,
});

/** A subscription entry. */
export type SubscriptionEntry = typeof SubscriptionEntrySchema.Type;

/** One file of a set. */
export const SetFileSchema = Struct({
  accessRules: optionalKey(SchemaArray(AccessRuleEntrySchema)),
  grants: optionalKey(SchemaArray(GrantEntrySchema)),
  namespaces: optionalKey(SchemaArray(NamespaceEntrySchema)),
  permissions: optionalKey(SchemaArray(NamedEntrySchema)),
  roles: optionalKey(SchemaArray(NamedEntrySchema)),
  set: optionalKey(SetHeaderSchema),
  subscriptions: optionalKey(SchemaArray(SubscriptionEntrySchema)),
  tables: optionalKey(SchemaArray(TableEntrySchema)),
});

/** One parsed file of a set. */
export type SetFile = typeof SetFileSchema.Type;

/** A file of a set with the path it was read from, for messages. */
export interface NamedSetFile {
  readonly path: string;
  readonly content: SetFile;
}
