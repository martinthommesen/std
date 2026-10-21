/**
 * `SchemaBusy`: another schema change holds `SCHEMA_KEY` (Contracts 1.4).
 */
import { Schema } from "effect";

/**
 * Another change set with DDL or a data preflight holds `SCHEMA_KEY`
 * (HTTP 503 with `Retry-After`). No queue in v0.1.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaBusy extends Schema.TaggedError<
  SchemaBusy,
  { readonly brand: unique symbol }
>()("SchemaBusy", {
  /** The change set holding the lock, if it is one (not `std upgrade`). */
  changeSetId: Schema.NullOr(Schema.String),
  /** Backend PIDs holding `SCHEMA_KEY`. */
  holderPids: Schema.Array(Schema.Int),
  retryAfterSeconds: Schema.Int,
}) {
  /**
   * Names the holder by change set and PID.
   * @returns The message.
   */
  override get message(): string {
    const holder = this.changeSetId ?? "a session without a change set";

    return `Another schema change is running (${holder}, pids ${this.holderPids.join(", ")}); retry after ${this.retryAfterSeconds} s`;
  }
}
