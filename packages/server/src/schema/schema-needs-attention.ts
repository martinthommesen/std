/**
 * `SchemaNeedsAttention`: a change set with DDL waits for an operator
 * (Contracts 1.5, 8.7).
 */
import { Schema } from "effect";

/**
 * Another change set is `needs_attention`: its follow-up steps failed
 * repeatedly and their stored statements name tables and columns as they
 * were. A new change set with DDL or a data preflight could rename or drop
 * them under it, so it is refused (HTTP 409) until an admin runs
 * `std schema resume <id>` or `std schema abandon <id>`. Changes without
 * DDL (labels, access rules) still apply.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaNeedsAttention extends Schema.TaggedError<
  SchemaNeedsAttention,
  { readonly brand: unique symbol }
>()("SchemaNeedsAttention", {
  changeSetId: Schema.String,
  /** The change set's last error. */
  error: Schema.NullOr(Schema.String),
}) {
  /**
   * Names the change set.
   * @returns The message.
   */
  override get message(): string {
    return `Change set ${this.changeSetId} needs attention; run std schema resume or std schema abandon first`;
  }
}
