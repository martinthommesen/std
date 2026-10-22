/**
 * `DefinitionProtected` (Contracts 1.1, 1.8, HTTP 403): the schema service
 * refuses to change a definition, for every caller, admins included.
 */
import { Literals, String as SchemaString, TaggedError } from "effect/Schema";

/** Why a definition cannot be changed by this origin. */
export const ProtectionReasonSchema = Literals([
  /** A protected core definition: only label and help text may change. */
  "protected",
  /** Owned by core or an app set, and the change set is not that set. */
  "owner",
  /** The `core` namespace or an installed app's namespace. */
  "reserved",
  /** A core class not marked `extensible`. */
  "notExtensible",
  /** A platform table, owned by platform migrations. */
  "platform",
]);

/** A protection reason. */
export type ProtectionReason = typeof ProtectionReasonSchema.Type;

/** The schema service refuses to change a definition (Contracts 1.8). */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class DefinitionProtected extends TaggedError<
  DefinitionProtected,
  { readonly brand: unique symbol }
>()("DefinitionProtected", {
  definitionId: SchemaString,
  operation: SchemaString,
  reason: ProtectionReasonSchema,
}) {
  /**
   * Names the definition and the reason.
   *
   * @returns The message.
   */
  override get message(): string {
    return `Cannot ${this.operation} ${this.definitionId}: ${this.reason}`;
  }
}
