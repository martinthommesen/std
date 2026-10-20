/**
 * The definition model (Contracts 1, 2.5, 3.1, 4.6, 8.1): every kind of
 * configuration record the schema engine stores, with its stable ID, its
 * name, its owner layer, its lifecycle state and its flags.
 *
 * These are the effective records the runtime reads (Contracts 8.2). Each
 * kind is stored in its own platform table (`core.namespace`, `core.class`,
 * `core.field`, ...); `version` is that row's record version, bumped by
 * every change set that changes the definition.
 */
import { FieldTypeSchema } from "@std/values/field-type";
import {
  Array as SchemaArray,
  Boolean as SchemaBoolean,
  Finite,
  Int,
  isGreaterThanOrEqualTo,
  Json,
  Literal,
  Literals,
  NullOr,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import { DefinitionIdSchema } from "./ids.ts";

/** Owner layers (Contracts 8.1). */
export const OwnerLayerSchema = Literals(["core", "app", "local"]);

/** An owner layer. */
export type OwnerLayer = typeof OwnerLayerSchema.Type;

/** Who owns a definition: core, an app set (by ID) or this install. */
export const OwnerSchema = Union([
  Struct({ layer: Literal("core") }),
  Struct({ layer: Literal("app"), setId: DefinitionIdSchema }),
  Struct({ layer: Literal("local") }),
]);

/** The owner of a definition. */
export type Owner = typeof OwnerSchema.Type;

/** Lifecycle states (Contracts 1.6). A purged definition is a tombstone. */
export const LifecycleStateSchema = Literals(["active", "retired", "purged"]);

/** A lifecycle state. */
export type LifecycleState = typeof LifecycleStateSchema.Type;

/**
 * Whether the database enforces a constraint, index or override yet
 * (Contracts 1.4).
 */
export const EnforcementSchema = Literals(["pending", "enforced", "failed"]);

/** An enforcement state. */
export type Enforcement = typeof EnforcementSchema.Type;

/**
 * Where a namespace's schema or a class's table comes from: `standard` ones
 * are created by change sets, `platform` ones by platform migrations and only
 * verified by the loader (Contracts 1.9).
 */
export const StorageSchema = Literals(["standard", "platform"]);

/** A storage kind. */
export type Storage = typeof StorageSchema.Type;

const Version = Int.check(isGreaterThanOrEqualTo(1));

const NullableText = NullOr(SchemaString);

/** Properties every draft has: what a create operation supplies. */
const draft = {
  id: DefinitionIdSchema,
  owner: OwnerSchema,
  protected: SchemaBoolean,
} as const;

/** Properties every stored definition has. */
const common = {
  ...draft,
  state: LifecycleStateSchema,
  version: Version,
} as const;

const enforcement = {
  enforcement: EnforcementSchema,
  enforcementNote: NullableText,
} as const;

/** Properties of a namespace definition that its draft has too. */
const namespaceFields = {
  extensible: SchemaBoolean,
  helpText: NullableText,
  kind: Literal("namespace"),
  label: SchemaString,
  name: SchemaString,
  storage: StorageSchema,
} as const;

/** A namespace: a Postgres schema holding tables. */
export const NamespaceDefinitionSchema = Struct({
  ...common,
  ...namespaceFields,
});

/** What a create operation supplies for a namespace definition. */
export const NamespaceDraftSchema = Struct({ ...draft, ...namespaceFields });

/** A namespace draft. */
export type NamespaceDraft = typeof NamespaceDraftSchema.Type;

/** A namespace definition. */
export type NamespaceDefinition = typeof NamespaceDefinitionSchema.Type;

/** Properties of a class definition that its draft has too. */
const classFields = {
  displayFieldId: NullOr(DefinitionIdSchema),
  extensible: SchemaBoolean,
  helpText: NullableText,
  kind: Literal("class"),
  label: SchemaString,
  name: SchemaString,
  namespaceId: DefinitionIdSchema,
  parentId: NullOr(DefinitionIdSchema),
  storage: StorageSchema,
} as const;

/**
 * A class: a table definition, optionally extending a parent class. The
 * enforcement state describes its subtree CHECK (Contracts 2.4).
 */
export const ClassDefinitionSchema = Struct({
  ...common,
  ...enforcement,
  ...classFields,
});

/** What a create operation supplies for a class definition. */
export const ClassDraftSchema = Struct({ ...draft, ...classFields });

/** A class draft. */
export type ClassDraft = typeof ClassDraftSchema.Type;

/** A class definition. */
export type ClassDefinition = typeof ClassDefinitionSchema.Type;

/** Properties of a field definition that its draft has too. */
const fieldFields = {
  classId: DefinitionIdSchema,
  default: NullOr(Json),
  helpText: NullableText,
  kind: Literal("field"),
  label: SchemaString,
  name: SchemaString,
  readOnly: SchemaBoolean,
  required: SchemaBoolean,
  type: FieldTypeSchema,
} as const;

/**
 * A field of a class: its type and settings (`@std/values`), whether it is
 * required or read-only, and a constant default in canonical JSON. The
 * enforcement state describes its database constraints (NOT NULL, max
 * length CHECK, reference FK).
 */
export const FieldDefinitionSchema = Struct({
  ...common,
  ...enforcement,
  ...fieldFields,
});

/** What a create operation supplies for a field definition. */
export const FieldDraftSchema = Struct({ ...draft, ...fieldFields });

/** A field draft. */
export type FieldDraft = typeof FieldDraftSchema.Type;

/** A field definition. */
export type FieldDefinition = typeof FieldDefinitionSchema.Type;

/** A numeric bound of an override: a number for integer, a string otherwise. */
const Bound = NullOr(Union([Finite, SchemaString]));

/** Properties of a override definition that its draft has too. */
const overrideFields = {
  classId: DefinitionIdSchema,
  default: NullOr(Json),
  fieldId: DefinitionIdSchema,
  helpText: NullableText,
  kind: Literal("override"),
  label: NullableText,
  max: Bound,
  maxLength: NullOr(Int),
  min: Bound,
  readOnly: NullOr(SchemaBoolean),
  required: NullOr(SchemaBoolean),
} as const;

/**
 * A child-class override of an inherited field (Contracts 2.5). Null means
 * "not overridden". It may only tighten: required and read-only only become
 * true, max length and numeric bounds only narrow.
 */
export const OverrideDefinitionSchema = Struct({
  ...common,
  ...enforcement,
  ...overrideFields,
});

/** What a create operation supplies for a override definition. */
export const OverrideDraftSchema = Struct({ ...draft, ...overrideFields });

/** A override draft. */
export type OverrideDraft = typeof OverrideDraftSchema.Type;

/** An override definition. */
export type OverrideDefinition = typeof OverrideDefinitionSchema.Type;

/** Properties of a index definition that its draft has too. */
const indexFields = {
  classId: DefinitionIdSchema,
  fieldIds: SchemaArray(DefinitionIdSchema),
  kind: Literal("index"),
  unique: SchemaBoolean,
} as const;

/** An index on fields of one class table. */
export const IndexDefinitionSchema = Struct({
  ...common,
  ...enforcement,
  ...indexFields,
});

/** What a create operation supplies for a index definition. */
export const IndexDraftSchema = Struct({ ...draft, ...indexFields });

/** A index draft. */
export type IndexDraft = typeof IndexDraftSchema.Type;

/** An index definition. */
export type IndexDefinition = typeof IndexDefinitionSchema.Type;

/** Properties of a role definition that its draft has too. */
const roleFields = {
  helpText: NullableText,
  kind: Literal("role"),
  label: SchemaString,
  name: SchemaString,
} as const;

/** A flat role (Contracts 3.1). */
export const RoleDefinitionSchema = Struct({
  ...common,
  ...roleFields,
});

/** What a create operation supplies for a role definition. */
export const RoleDraftSchema = Struct({ ...draft, ...roleFields });

/** A role draft. */
export type RoleDraft = typeof RoleDraftSchema.Type;

/** A role definition. */
export type RoleDefinition = typeof RoleDefinitionSchema.Type;

/** Properties of a permission definition that its draft has too. */
const permissionFields = {
  helpText: NullableText,
  kind: Literal("permission"),
  label: SchemaString,
  name: SchemaString,
} as const;

/** A built-in capability outside access rules, such as `schema.purge`. */
export const PermissionDefinitionSchema = Struct({
  ...common,
  ...permissionFields,
});

/** What a create operation supplies for a permission definition. */
export const PermissionDraftSchema = Struct({ ...draft, ...permissionFields });

/** A permission draft. */
export type PermissionDraft = typeof PermissionDraftSchema.Type;

/** A permission definition. */
export type PermissionDefinition = typeof PermissionDefinitionSchema.Type;

/** Properties of a grant definition that its draft has too. */
const grantFields = {
  kind: Literal("grant"),
  permissionId: DefinitionIdSchema,
  roleId: DefinitionIdSchema,
} as const;

/** A permission granted to a role (`core.role_permission`). */
export const GrantDefinitionSchema = Struct({
  ...common,
  ...grantFields,
});

/** What a create operation supplies for a grant definition. */
export const GrantDraftSchema = Struct({ ...draft, ...grantFields });

/** A grant draft. */
export type GrantDraft = typeof GrantDraftSchema.Type;

/** A grant definition. */
export type GrantDefinition = typeof GrantDefinitionSchema.Type;

/** Access-rule actions (Contracts 3.1). */
export const AccessActionSchema = Literals([
  "read",
  "create",
  "update",
  "delete",
]);

/** An access-rule action. */
export type AccessAction = typeof AccessActionSchema.Type;

/** What an access rule applies to: the records, or fields (a list or `*`). */
export const AccessTargetSchema = Union([
  Struct({ kind: Literal("records") }),
  Struct({
    fields: Union([Literal("*"), SchemaArray(DefinitionIdSchema)]),
    kind: Literal("fields"),
  }),
]);

/** An access-rule target. */
export type AccessTarget = typeof AccessTargetSchema.Type;

/** Properties of a accessRule definition that its draft has too. */
const accessRuleFields = {
  actions: SchemaArray(AccessActionSchema),
  active: SchemaBoolean,
  classId: NullOr(DefinitionIdSchema),
  condition: NullOr(ConditionSchema),
  description: NullableText,
  effect: Literals(["allow", "deny"]),
  kind: Literal("accessRule"),
  roleIds: SchemaArray(DefinitionIdSchema),
  target: AccessTargetSchema,
} as const;

/**
 * An access rule (Contracts 3.1, 3.2). `classId` null means `*`, every
 * class. An inactive rule never applies.
 */
export const AccessRuleDefinitionSchema = Struct({
  ...common,
  ...accessRuleFields,
});

/** What a create operation supplies for a accessRule definition. */
export const AccessRuleDraftSchema = Struct({ ...draft, ...accessRuleFields });

/** A accessRule draft. */
export type AccessRuleDraft = typeof AccessRuleDraftSchema.Type;

/** An access-rule definition. */
export type AccessRuleDefinition = typeof AccessRuleDefinitionSchema.Type;

/** Operations a subscription can match (Contracts 4.6). */
export const SubscriptionOperationSchema = Literals([
  "create",
  "update",
  "delete",
]);

/** Properties of a subscription definition that its draft has too. */
const subscriptionFields = {
  classId: DefinitionIdSchema,
  condition: NullOr(ConditionSchema),
  deadLetter: Literals(["block", "skip"]),
  enabled: SchemaBoolean,
  identityId: DefinitionIdSchema,
  kind: Literal("subscription"),
  maxAttempts: Int.check(isGreaterThanOrEqualTo(1)),
  name: SchemaString,
  operations: SchemaArray(SubscriptionOperationSchema),
} as const;

/**
 * An outbox subscription (Contracts 4.6). The producer that writes delivery
 * rows comes with workstream 1E; the definition is config already.
 */
export const SubscriptionDefinitionSchema = Struct({
  ...common,
  ...subscriptionFields,
});

/** What a create operation supplies for a subscription definition. */
export const SubscriptionDraftSchema = Struct({
  ...draft,
  ...subscriptionFields,
});

/** A subscription draft. */
export type SubscriptionDraft = typeof SubscriptionDraftSchema.Type;

/** A subscription definition. */
export type SubscriptionDefinition = typeof SubscriptionDefinitionSchema.Type;

/** Any definition. */
export const DefinitionSchema = Union([
  NamespaceDefinitionSchema,
  ClassDefinitionSchema,
  FieldDefinitionSchema,
  OverrideDefinitionSchema,
  IndexDefinitionSchema,
  RoleDefinitionSchema,
  PermissionDefinitionSchema,
  GrantDefinitionSchema,
  AccessRuleDefinitionSchema,
  SubscriptionDefinitionSchema,
]);

/** Any definition. */
export type Definition = typeof DefinitionSchema.Type;

/** The kind of a definition. */
export type DefinitionKind = Definition["kind"];

/** The definition of one kind. */
export type DefinitionOf<K extends DefinitionKind> = Extract<
  Definition,
  { readonly kind: K }
>;

/** Every definition kind, in the order the snapshot lists them. */
export const DEFINITION_KINDS: readonly DefinitionKind[] = [
  "namespace",
  "class",
  "field",
  "override",
  "index",
  "role",
  "permission",
  "grant",
  "accessRule",
  "subscription",
];

/**
 * Whether a definition is not a purged tombstone.
 *
 * @param definition - Any definition.
 * @returns True for active and retired definitions.
 */
export const isLive = (definition: Definition): boolean =>
  definition.state !== "purged";

/**
 * Whether a definition is active.
 *
 * @param definition - Any definition.
 * @returns True for active definitions.
 */
export const isActive = (definition: Definition): boolean =>
  definition.state === "active";
