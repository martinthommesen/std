/**
 * The operation model of change sets (Contracts 1.4, 1.5).
 *
 * A change set is an ordered list of operations applied in one main
 * transaction. Create operations carry a draft with the new definition's
 * ID; every operation that modifies an existing definition names the
 * `version` it was read at, and a different stored version is a
 * `versionConflict`.
 *
 * `update` carries only the properties that change. Which properties an
 * update may change depends on the kind (`UPDATABLE`); names, lifecycle
 * states, types, parents, reference targets and index fields cannot change
 * through it. Lifecycle operations (Contracts 1.1, 1.6, 1.7):
 *
 * - `rename`: a new name by ID (namespaces, tables, fields, roles,
 *   permissions, subscriptions); physical names follow, generated `std_*`
 *   names never change;
 * - `retire` and `reactivate`: fields, tables and roles;
 * - `purge`: a field or table retired in an earlier committed revision,
 *   with a confirmation naming its ID and version; needs `schema.purge`;
 * - `delete`: what a generic `DELETE` asks for. Refused with
 *   `UseRetireOrPurge` for fields, tables and namespaces; drops an index
 *   (follow-up `DROP INDEX CONCURRENTLY`); removes a role, grant, access
 *   rule, subscription or permission, leaving a tombstone.
 *
 * Type changes are refused in v0.1.
 */
import {
  Int,
  isGreaterThanOrEqualTo,
  Json,
  Literal,
  NullOr,
  Record as SchemaRecord,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import {
  AccessRuleDraftSchema,
  ClassDraftSchema,
  FieldDraftSchema,
  GrantDraftSchema,
  IndexDraftSchema,
  NamespaceDraftSchema,
  OverrideDraftSchema,
  PermissionDraftSchema,
  RoleDraftSchema,
  SubscriptionDraftSchema,
} from "./definition.ts";
import type { DefinitionKind } from "./definition.ts";
import { DefinitionIdSchema } from "./ids.ts";

const Version = Int.check(isGreaterThanOrEqualTo(1));

/** Every operation of a change set. */
export const OperationSchema = Union([
  Struct({ definition: NamespaceDraftSchema, op: Literal("createNamespace") }),
  Struct({ definition: ClassDraftSchema, op: Literal("createClass") }),
  Struct({ definition: FieldDraftSchema, op: Literal("addField") }),
  Struct({ definition: IndexDraftSchema, op: Literal("addIndex") }),
  Struct({ definition: RoleDraftSchema, op: Literal("createRole") }),
  Struct({
    definition: PermissionDraftSchema,
    op: Literal("createPermission"),
  }),
  Struct({ definition: GrantDraftSchema, op: Literal("createGrant") }),
  Struct({
    definition: AccessRuleDraftSchema,
    op: Literal("createAccessRule"),
  }),
  Struct({
    definition: SubscriptionDraftSchema,
    op: Literal("createSubscription"),
  }),
  /**
   * Adds an override (`version` null) or replaces the stored one
   * (`version` its current version). Loosening is refused.
   */
  Struct({
    definition: OverrideDraftSchema,
    op: Literal("setOverride"),
    version: NullOr(Version),
  }),
  /** Changes some properties of an existing definition. */
  Struct({
    changes: SchemaRecord(SchemaString, Json),
    id: DefinitionIdSchema,
    op: Literal("update"),
    version: Version,
  }),
  /** Gives a definition a new name; everything refers to it by ID. */
  Struct({
    id: DefinitionIdSchema,
    name: SchemaString,
    op: Literal("rename"),
    version: Version,
  }),
  /** Retires an active field, table or role: data kept, writes refused. */
  Struct({ id: DefinitionIdSchema, op: Literal("retire"), version: Version }),
  /** Makes a retired field, table or role active again (a field comes back optional). */
  Struct({
    id: DefinitionIdSchema,
    op: Literal("reactivate"),
    version: Version,
  }),
  /**
   * Drops a retired field's column or a retired table and leaves a
   * tombstone. `confirm` must repeat the target's ID and version.
   */
  Struct({
    confirm: Struct({ id: DefinitionIdSchema, version: Version }),
    id: DefinitionIdSchema,
    op: Literal("purge"),
    version: Version,
  }),
  /** Deletes a definition record (see the module comment for what each kind does). */
  Struct({ id: DefinitionIdSchema, op: Literal("delete"), version: Version }),
]);

/** A change-set operation. */
export type Operation = typeof OperationSchema.Type;

/** An operation's tag. */
export type OperationName = Operation["op"];

/** A create operation. */
export type CreateOperation = Extract<
  Operation,
  { readonly definition: unknown; readonly op: `${"add" | "create"}${string}` }
>;

/** An operation on an existing definition named by `id`. */
export type TargetedOperation = Extract<Operation, { readonly id: string }>;

/** The tags of lifecycle operations. */
export type LifecycleOperationName = Exclude<TargetedOperation["op"], "update">;

/** The kinds `rename` applies to: the kinds with a name. */
export const RENAMABLE: ReadonlySet<DefinitionKind> = new Set<DefinitionKind>([
  "namespace",
  "class",
  "field",
  "index",
  "role",
  "permission",
  "accessRule",
  "subscription",
]);

/** The kinds `retire` and `reactivate` apply to. */
export const RETIRABLE: ReadonlySet<DefinitionKind> = new Set<DefinitionKind>([
  "class",
  "field",
  "role",
]);

/** The kinds `purge` applies to. */
export const PURGEABLE: ReadonlySet<DefinitionKind> = new Set<DefinitionKind>([
  "class",
  "field",
]);

/** The kinds a `delete` is refused for with `UseRetireOrPurge`. */
export const NEVER_DELETED: ReadonlySet<DefinitionKind> =
  new Set<DefinitionKind>(["namespace", "class", "field"]);

/**
 * Properties `update` may change, per kind. Field `required` may only
 * become true (a tightening with a data preflight); `default` is a constant.
 */
export const UPDATABLE: Readonly<Record<DefinitionKind, readonly string[]>> = {
  accessRule: [
    "actions",
    "active",
    "classId",
    "condition",
    "description",
    "effect",
    "roleIds",
    "target",
  ],
  class: ["displayFieldId", "helpText", "label"],
  field: ["default", "helpText", "label", "readOnly", "required"],
  grant: [],
  index: [],
  namespace: ["helpText", "label"],
  override: [],
  permission: ["helpText", "label"],
  role: ["helpText", "label"],
  subscription: [
    "classId",
    "condition",
    "deadLetter",
    "enabled",
    "identityId",
    "maxAttempts",
    "operations",
  ],
};
