/**
 * Who asks for a change set, and from where (Contracts 1.6, 1.7, 1.8, 3.1).
 *
 * - The **requester** is the acting user and the roles they hold right
 *   now. Permissions such as `schema.purge` are checked against it by
 *   permission ID, through the role grants of the configuration the change
 *   set starts from. Until the record service's `Actor` exists, callers
 *   pass the requester explicitly; the HTTP layer will build it from the
 *   `Actor`.
 * - The **origin** says whether the change set comes from a definition set
 *   (which owns its definitions and may rename or retire them) or from a
 *   local edit (an admin through the API). Protected definitions accept
 *   only label and help-text changes from any origin but the core set.
 */
import { Array as SchemaArray, Literal, Struct, Union } from "effect/Schema";

import { isActive, OwnerSchema } from "./definition.ts";
import type { Owner } from "./definition.ts";
import { DefinitionIdSchema } from "./ids.ts";
import type { DefinitionId } from "./ids.ts";
import { PermissionRequired } from "./permission-required.ts";
import type { ConfigSnapshot } from "./snapshot.ts";
import { SYSTEM_USER_ID } from "./well-known.ts";

/** The acting user of a change set and the roles they hold. */
export const RequesterSchema = Struct({
  /** Every role the user holds now, `authenticated` included. */
  roleIds: SchemaArray(DefinitionIdSchema),
  userId: DefinitionIdSchema,
});

/** A requester. */
export type Requester = typeof RequesterSchema.Type;

/**
 * The system user without roles: the requester of bootstrap and definition
 * set loads (Contracts 3.1). It holds no permission.
 */
export const SYSTEM_REQUESTER: Requester = {
  roleIds: [],
  userId: SYSTEM_USER_ID,
};

/** Where a change set comes from. */
export const ChangeOriginSchema = Union([
  Struct({ kind: Literal("local") }),
  Struct({ kind: Literal("set"), owner: OwnerSchema }),
]);

/** A change set's origin. */
export type ChangeOrigin = typeof ChangeOriginSchema.Type;

/** A local edit: an admin through the API. */
export const LOCAL_ORIGIN: ChangeOrigin = { kind: "local" };

/**
 * The origin of a definition set load.
 *
 * @param owner - The set's owner (`core`, or `app` with the set's ID).
 * @returns The origin.
 */
export const setOrigin = (owner: Owner): ChangeOrigin => ({
  kind: "set",
  owner,
});

/**
 * The owner layer an origin creates definitions in.
 *
 * @param origin - An origin.
 * @returns `local` for local edits, the set's owner for set loads.
 */
export const ownerOfOrigin = (origin: ChangeOrigin): Owner =>
  origin.kind === "local" ? { layer: "local" } : origin.owner;

/**
 * Whether an origin owns definitions of an owner: local edits own local
 * definitions, a set owns its own.
 *
 * @param origin - An origin.
 * @param owner - A definition's owner.
 * @returns True when the origin is the owner.
 */
export const originOwns = (origin: ChangeOrigin, owner: Owner): boolean => {
  const mine = ownerOfOrigin(origin);

  if (mine.layer === "app" && owner.layer === "app") {
    return mine.setId === owner.setId;
  }

  return mine.layer === owner.layer;
};

/**
 * Whether the origin is the core definition set, the only origin that may
 * change protected definitions (Contracts 1.8).
 *
 * @param origin - An origin.
 * @returns True for the core set.
 */
export const isCoreOrigin = (origin: ChangeOrigin): boolean =>
  origin.kind === "set" && origin.owner.layer === "core";

/**
 * Whether a requester holds a permission (Contracts 3.1): an active role
 * the requester holds has a live grant of the active permission. Checked by
 * permission ID; no code checks a role name, and `admin` holds nothing
 * implicitly.
 *
 * @param snapshot - The configuration the change set starts from.
 * @param requester - The requester.
 * @param permissionId - The permission's stable ID.
 * @returns True when one of the requester's roles is granted it.
 */
export const hasPermission = (
  snapshot: ConfigSnapshot,
  requester: Requester,
  permissionId: DefinitionId
): boolean => {
  const permission = snapshot.getKind("permission", permissionId);

  if (permission === undefined || !isActive(permission)) {
    return false;
  }

  const held = new Set(requester.roleIds);

  const activeRole = (roleId: DefinitionId): boolean => {
    const role = snapshot.role(roleId);

    return role !== undefined && isActive(role) && held.has(roleId);
  };

  return snapshot
    .grants()
    .some(
      (grant) =>
        isActive(grant) &&
        grant.permissionId === permissionId &&
        activeRole(grant.roleId)
    );
};

/**
 * The refusal for a missing permission, labelled from the starting snapshot.
 *
 * @param snapshot - The configuration the change set starts from.
 * @param requester - The requester.
 * @param permissionId - The permission's stable ID.
 * @returns The refusal, or undefined when the permission is held.
 */
export const permissionRefusal = (
  snapshot: ConfigSnapshot,
  requester: Requester,
  permissionId: DefinitionId
): PermissionRequired | undefined => {
  if (hasPermission(snapshot, requester, permissionId)) {
    return undefined;
  }

  const permission = snapshot.getKind("permission", permissionId);

  return new PermissionRequired({
    permission: permission?.name ?? permissionId,
    permissionId,
  });
};
