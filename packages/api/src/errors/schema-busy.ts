/**
 * `SchemaBusy` (Contracts 1.4, HTTP 503 with `Retry-After`).
 */
import { Schema } from "effect";

/**
 * Another change set with DDL or a data preflight holds `SCHEMA_KEY`. No
 * queue in v0.1: retry after `retryAfterSeconds`.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaBusy extends Schema.TaggedError<
  SchemaBusy,
  { readonly brand: unique symbol }
>()(
  "SchemaBusy",
  {
    /** The change set holding the lock, if it is one. */
    changeSetId: Schema.NullOr(Schema.String),
    retryAfterSeconds: Schema.Int,
  },
  { httpApiStatus: 503 }
) {
  /**
   * Names the holder.
   * @returns The message.
   */
  override get message(): string {
    return `Another schema change is running; retry after ${this.retryAfterSeconds} s`;
  }
}
