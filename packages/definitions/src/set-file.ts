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
 *       - { id: <uuid>, name: docked_to,
 *           type: { kind: reference, target: acme.asset,
 *                   allowedRecords: { op: notEmpty, arg: { path: [<field id>] } } } }
 *       - { id: <uuid>, name: due_when,
 *           type: { kind: condition, class: acme.asset, profile: filter } }
 *     overrides:
 *       - { id: <uuid>, field: purchased_on, required: true }
 *     indexes:
 *       - { id: <uuid>, fields: [serial], unique: true }
 *     layouts:
 *       - { id: <uuid>, type: list, elements: [{ field: name }, { field: serial }] }
 *     savedFilters:
 *       - { id: <uuid>, name: mine, label: Mine,
 *           condition: { op: eq, left: { path: [<owner field ID>] }, right: { ctx: me } } }
 * roles: [{ id: <uuid>, name: asset_manager, label: Asset manager }]
 * permissions: [{ id: <uuid>, name: schema.purge, label: Purge schema }]
 * grants: [{ id: <uuid>, role: schema_purger, permission: schema.purge }]
 * accessRules:
 *   - { id: <uuid>, effect: allow, roles: [admin], table: "*", target: records,
 *       actions: [read, create, update, delete] }
 * subscriptions: []
 * recordRules:
 *   - { id: <uuid>, name: needs_notes, table: acme.asset, phase: before,
 *       kind: guard, operations: [update], order: 10,
 *       condition: { op: empty, arg: { path: [<notes field ID>] } },
 *       actions: [{ type: refuse, code: RuleRefused, message: Notes needed }] }
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
  LayoutTypeSchema,
  StorageSchema,
  SubscriptionOperationSchema,
} from "./definition.ts";
import {
  ClearHiddenSchema,
  FormRulePropertySchema,
  FormRuleValueSchema,
} from "./form-rule-schema.ts";
import { DefinitionIdSchema } from "./ids.ts";
import {
  RuleActionSchema,
  RuleKindSchema,
  RuleOperationSchema,
  RulePhaseSchema,
} from "./rule-definition.ts";

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
  "choice",
]);

/**
 * A reference type in a file names its target table and, optionally, its
 * allowed-records condition, a JSON AST over the target with field IDs, as
 * access-rule conditions are written (decision 0020). `aggregate: true`
 * makes it its table's owner reference (Contracts 4.9, 6.5).
 */
export const ReferenceEntrySchema = Struct({
  aggregate: optionalKey(SchemaBoolean),
  allowedRecords: optionalKey(ConditionSchema),
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

/**
 * A choice of a choice field; `order` defaults to its 1-based position in
 * the field's list.
 */
export const ChoiceEntrySchema = Struct({
  hidden: optionalKey(SchemaBoolean),
  id: DefinitionIdSchema,
  key: SchemaString,
  label: SchemaString,
  order: optionalKey(Int),
  protected: optionalKey(SchemaBoolean),
});

/** One choice entry. */
export type ChoiceEntry = typeof ChoiceEntrySchema.Type;

/** A field entry. */
export const FieldEntrySchema = Struct({
  ...flags,
  choices: optionalKey(SchemaArray(ChoiceEntrySchema)),
  default: optionalKey(Json),
  name: SchemaString,
  numberPrefix: optionalKey(SchemaString),
  readOnly: optionalKey(SchemaBoolean),
  required: optionalKey(SchemaBoolean),
  type: TypeEntrySchema,
});

/** A field entry. */
export type FieldEntry = typeof FieldEntrySchema.Type;

const BoundEntry = Union([Finite, SchemaString]);

/** An override entry: tightens an inherited field, named by field name. */
export const OverrideEntrySchema = Struct({
  choices: optionalKey(SchemaArray(SchemaString)),
  default: optionalKey(Json),
  field: SchemaString,
  helpText: optionalKey(SchemaString),
  id: DefinitionIdSchema,
  label: optionalKey(SchemaString),
  max: optionalKey(BoundEntry),
  maxLength: optionalKey(Int),
  min: optionalKey(BoundEntry),
  numberPrefix: optionalKey(SchemaString),
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

/** A layout element: a field of the table's lineage by name, or a section. */
export const LayoutElementEntrySchema = Union([
  Struct({ field: SchemaString }),
  Struct({ section: SchemaString }),
]);

/** A layout element entry. */
export type LayoutElementEntry = typeof LayoutElementEntrySchema.Type;

/** A form or list layout of a table. */
export const LayoutEntrySchema = Struct({
  elements: SchemaArray(LayoutElementEntrySchema),
  id: DefinitionIdSchema,
  protected: optionalKey(SchemaBoolean),
  type: LayoutTypeSchema,
});

/** One layout entry. */
export type LayoutEntry = typeof LayoutEntrySchema.Type;

/**
 * A saved list filter of a table (decision 0019): a `filter`-profile
 * condition AST whose paths hold field IDs, like every condition in a set
 * file. `label` defaults to the name, as for fields.
 */
export const SavedFilterEntrySchema = Struct({
  condition: ConditionSchema,
  id: DefinitionIdSchema,
  label: optionalKey(SchemaString),
  name: SchemaString,
  protected: optionalKey(SchemaBoolean),
});

/** One saved filter entry. */
export type SavedFilterEntry = typeof SavedFilterEntrySchema.Type;

/**
 * A table entry with its fields, overrides, indexes, layouts and saved
 * filters.
 */
export const TableEntrySchema = Struct({
  ...flags,
  displayField: optionalKey(SchemaString),
  extends: optionalKey(SchemaString),
  extensible: optionalKey(SchemaBoolean),
  fields: optionalKey(SchemaArray(FieldEntrySchema)),
  indexes: optionalKey(SchemaArray(IndexEntrySchema)),
  layouts: optionalKey(SchemaArray(LayoutEntrySchema)),
  /** The qualified name, `namespace.table`. */
  name: SchemaString,
  overrides: optionalKey(SchemaArray(OverrideEntrySchema)),
  savedFilters: optionalKey(SchemaArray(SavedFilterEntrySchema)),
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

/**
 * A record-rule entry (Contracts 4.10, decision 0022). Its condition and
 * actions are stored JSON, holding field and class IDs like every
 * condition in a set file; `runAs` (a user) and `subscription` are IDs.
 * `active` defaults to true, `once` to false, `order` to 0 and
 * `operations` to none (the `aggregate` phase has none).
 */
export const RecordRuleEntrySchema = Struct({
  actions: SchemaArray(RuleActionSchema),
  active: optionalKey(SchemaBoolean),
  condition: optionalKey(ConditionSchema),
  description: optionalKey(SchemaString),
  id: DefinitionIdSchema,
  /** A `before` rule's kind: `derive`, `guard` or `invariant`. */
  kind: optionalKey(RuleKindSchema),
  name: SchemaString,
  once: optionalKey(SchemaBoolean),
  operations: optionalKey(SchemaArray(RuleOperationSchema)),
  order: optionalKey(Int),
  phase: RulePhaseSchema,
  protected: optionalKey(SchemaBoolean),
  runAs: optionalKey(DefinitionIdSchema),
  subscription: optionalKey(DefinitionIdSchema),
  /** The qualified name of the class the rule is attached to. */
  table: SchemaString,
});

/** A record-rule entry. */
export type RecordRuleEntry = typeof RecordRuleEntrySchema.Type;

/** A form rule; field names resolve to stable IDs on its table. */
export const FormRuleEntrySchema = Struct({
  active: optionalKey(SchemaBoolean),
  clearHidden: optionalKey(ClearHiddenSchema),
  condition: optionalKey(ConditionSchema),
  field: SchemaString,
  id: DefinitionIdSchema,
  message: optionalKey(SchemaString),
  name: SchemaString,
  order: optionalKey(Int),
  property: FormRulePropertySchema,
  protected: optionalKey(SchemaBoolean),
  table: SchemaString,
  value: optionalKey(FormRuleValueSchema),
});

/** One file of a set. */
export const SetFileSchema = Struct({
  accessRules: optionalKey(SchemaArray(AccessRuleEntrySchema)),
  formRules: optionalKey(SchemaArray(FormRuleEntrySchema)),
  grants: optionalKey(SchemaArray(GrantEntrySchema)),
  namespaces: optionalKey(SchemaArray(NamespaceEntrySchema)),
  permissions: optionalKey(SchemaArray(NamedEntrySchema)),
  recordRules: optionalKey(SchemaArray(RecordRuleEntrySchema)),
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
