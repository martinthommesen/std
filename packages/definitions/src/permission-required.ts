/**
 * `PermissionRequired` (Contracts 3.1, HTTP 403): the requester lacks a
 * permission, checked by its stable ID through role grants.
 */
import { String as SchemaString, TaggedError } from "effect/Schema";

/** The requester holds no role granted the permission. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class PermissionRequired extends TaggedError<
  PermissionRequired,
  { readonly brand: unique symbol }
>()("PermissionRequired", {
  /** The permission's name, e.g. `schema.purge`. */
  permission: SchemaString,
  permissionId: SchemaString,
}) {
  /**
   * Names the permission.
   *
   * @returns The message.
   */
  override get message(): string {
    return `This change needs the ${this.permission} permission.`;
  }
}
