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
 * update may change depends on the kind (`UPDATABLE`); names, types,
 * parents, reference targets and index fields cannot change here (renames,
 * retire and purge come with workstream 1A; type changes are refused in
 * v0.1).
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
]);

/** A change-set operation. */
export type Operation = typeof OperationSchema.Type;

/** An operation's tag. */
export type OperationName = Operation["op"];

/** A create operation. */
export type CreateOperation = Exclude<
  Operation,
  { readonly op: "update" } | { readonly op: "setOverride" }
>;

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
