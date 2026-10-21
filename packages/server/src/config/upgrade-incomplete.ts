/**
 * `UpgradeIncomplete`: a change set of `std upgrade` (a set's, or one it
 * resumed) ended in `needs_attention` (Contracts 1.5, 8.5).
 */
import { Schema } from "effect";

/**
 * The upgrade stopped because a change set's follow-up steps failed. The
 * change set's main transaction committed; its steps wait for an admin.
 * Earlier steps of the upgrade stay committed.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UpgradeIncomplete extends Schema.TaggedError<
  UpgradeIncomplete,
  { readonly brand: unique symbol }
>()("UpgradeIncomplete", {
  changeSetId: Schema.String,
  /** The step's last error. */
  error: Schema.NullOr(Schema.String),
  /** The set whose change set it is, or null for a resumed one. */
  set: Schema.NullOr(Schema.String),
}) {
  /**
   * Names the change set and what to do.
   * @returns The message.
   */
  override get message(): string {
    const owner =
      this.set === null ? "A resumed change set" : `Set ${this.set}`;

    return `${owner}: change set ${this.changeSetId} needs attention (${this.error ?? "a follow-up step failed"}). Fix the cause and run std schema resume ${this.changeSetId}, or std schema abandon ${this.changeSetId}; then rerun std upgrade`;
  }
}
