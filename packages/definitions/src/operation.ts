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
 *   permissions, subscriptions, saved filters); physical names follow, generated `std_*`
 *   names never change;
 * - `retire` and `reactivate`: fields, tables and roles;
 * - `purge`: a field or table retired in an earlier committed revision,
 *   with a confirmation naming its ID and version; needs `schema.purge`;
 * - `delete`: what a generic `DELETE` asks for. Refused with
 *   `UseRetireOrPurge` for fields, tables and namespaces; drops an index
 *   (follow-up `DROP INDEX CONCURRENTLY`); removes a role, grant, access
 *   rule, subscription, permission, choice, layout or saved filter,
 *   leaving a tombstone.
 *
 * - `adopt`: moves a definition its set removed into the `local` layer
 *   (Contracts 8.1); only the config service issues it.
 *
 * Role and permission names may also change through `update`, as set loads
 * do; a local `update` of a name follows the same ownership rule as
 * `rename`. Type changes are refused in v0.1, except a reference's
 * allowed-records condition (decision 0020).
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
  ChoiceDraftSchema,
  ClassDraftSchema,
  FieldDraftSchema,
  GrantDraftSchema,
  IndexDraftSchema,
  LayoutDraftSchema,
  RecordRuleDraftSchema,
  SavedFilterDraftSchema,
  NamespaceDraftSchema,
  OverrideDraftSchema,
  PermissionDraftSchema,
  RoleDraftSchema,
  SubscriptionDraftSchema,
} from "./definition.ts";
import type { DefinitionKind } from "./definition.ts";
import { DefinitionIdSchema } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";

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
  Struct({ definition: ChoiceDraftSchema, op: Literal("createChoice") }),
  Struct({ definition: LayoutDraftSchema, op: Literal("createLayout") }),
  Struct({
    definition: SavedFilterDraftSchema,
    op: Literal("createSavedFilter"),
  }),
  Struct({
    definition: RecordRuleDraftSchema,
    op: Literal("createRecordRule"),
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
  /**
   * Moves a shipped definition its set removed into the `local` layer
   * (Contracts 8.1). Only the config service issues it, after checking
   * that the set removed the record; protected definitions refuse it.
   */
  Struct({
    id: DefinitionIdSchema,
    op: Literal("adopt"),
    version: Version,
  }),
]);

/** A change-set operation. */
export type Operation = typeof OperationSchema.Type;

/** What one operation tag does (Contracts 1.4). */
export interface OperationForm {
  /**
   * Whether it creates a definition under the client-chosen ID of its
   * draft: always, only without a `version` (`setOverride`), or never.
   */
  readonly create: "always" | "versionless" | "never";
  /** The kind it creates, or null. */
  readonly creates: DefinitionKind | null;
  /** Whether it acts on a stored definition named by ID. */
  readonly target: boolean;
}

/** The operation of one tag. */
type OperationOf<K extends Operation["op"]> = Extract<
  Operation,
  { readonly op: K }
>;

/**
 * The form one tag's schema implies, so a wrong table entry fails to
 * compile: a create carries a `definition` (only without a `version` when
 * it has one), its kind is the draft's, and a tag acts on a stored target
 * when it names an `id` or carries a `version` (`setOverride` replacing
 * an override).
 */
interface FormOf<K extends Operation["op"]> {
  readonly create: "definition" extends keyof OperationOf<K>
    ? "version" extends keyof OperationOf<K>
      ? "versionless"
      : "always"
    : "never";
  readonly creates: OperationOf<K> extends {
    readonly definition: { readonly kind: infer D };
  }
    ? D
    : null;
  readonly target: "id" extends keyof OperationOf<K>
    ? true
    : "version" extends keyof OperationOf<K>
      ? true
      : false;
}

/**
 * The form of every operation tag: which tags create (and what kind) and
 * which act on a stored target, each entry checked against the tag's
 * schema by its type. The engine takes created kinds and client-chosen
 * IDs from it (`apply.ts`, `occupancy.ts`), and the HTTP layer the stored
 * target it checks for visibility (`storedTargetId`).
 */
export const OPERATION_FORMS = {
  addField: { create: "always", creates: "field", target: false },
  addIndex: { create: "always", creates: "index", target: false },
  adopt: { create: "never", creates: null, target: true },
  createAccessRule: { create: "always", creates: "accessRule", target: false },
  createChoice: { create: "always", creates: "choice", target: false },
  createClass: { create: "always", creates: "class", target: false },
  createGrant: { create: "always", creates: "grant", target: false },
  createLayout: { create: "always", creates: "layout", target: false },
  createNamespace: { create: "always", creates: "namespace", target: false },
  createPermission: { create: "always", creates: "permission", target: false },
  createRecordRule: {
    create: "always",
    creates: "recordRule",
    target: false,
  },
  createRole: { create: "always", creates: "role", target: false },
  createSavedFilter: {
    create: "always",
    creates: "savedFilter",
    target: false,
  },
  createSubscription: {
    create: "always",
    creates: "subscription",
    target: false,
  },
  delete: { create: "never", creates: null, target: true },
  purge: { create: "never", creates: null, target: true },
  reactivate: { create: "never", creates: null, target: true },
  rename: { create: "never", creates: null, target: true },
  retire: { create: "never", creates: null, target: true },
  setOverride: { create: "versionless", creates: "override", target: true },
  update: { create: "never", creates: null, target: true },
} as const satisfies { readonly [K in Operation["op"]]: FormOf<K> };

/**
 * The stored definition an operation acts on, as `OPERATION_FORMS` says:
 * the `id` of a targeted tag, the override a versioned `setOverride`
 * replaces, nothing for a create.
 *
 * @param operation - The operation.
 * @returns The stored target's ID, or undefined.
 */
export const storedTargetId = (
  operation: Operation
): DefinitionId | undefined => {
  const form: OperationForm = OPERATION_FORMS[operation.op];

  if (!form.target) {
    return undefined;
  }

  if ("id" in operation) {
    return operation.id;
  }

  return "version" in operation && operation.version !== null
    ? operation.definition.id
    : undefined;
};

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
export type LifecycleOperationName = Exclude<
  TargetedOperation["op"],
  "update" | "adopt"
>;

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
  "savedFilter",
  "recordRule",
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
 * Field `type` may change only in a reference's `allowedRecords` (decision
 * 0020; any other type change is refused when the change set is applied).
 * Role, permission and saved-filter names may change: nothing refers to
 * them by name in stored config, so a rename needs no DDL (a new set version renames them, Contracts 8.4).
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
  choice: ["hidden", "label", "order"],
  class: ["displayFieldId", "helpText", "label"],
  field: [
    "default",
    "helpText",
    "label",
    "numberPrefix",
    "readOnly",
    "required",
    "type",
  ],
  grant: [],
  index: [],
  layout: ["elements"],
  namespace: ["helpText", "label"],
  override: [],
  permission: ["helpText", "label", "name"],
  recordRule: [
    "actions",
    "active",
    "classId",
    "condition",
    "description",
    "once",
    "operations",
    "order",
    "phase",
    "ruleKind",
    "runAsId",
    "subscriptionId",
  ],
  role: ["helpText", "label", "name"],
  savedFilter: ["condition", "label", "name"],
  subscription: [
    "hub",
    "classId",
    "condition",
    "deadLetter",
    "enabled",
    "identityId",
    "maxAttempts",
    "operations",
  ],
};
