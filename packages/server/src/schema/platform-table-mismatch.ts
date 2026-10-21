/**
 * `PlatformTableMismatch`: a platform table that differs from its description (Contracts 1.9).
 */
import { Schema } from "effect";

/**
 * A platform table does not match its class description in the core set
 * (Contracts 1.9): the loader verifies platform tables and never changes
 * them.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class PlatformTableMismatch extends Schema.TaggedError<
  PlatformTableMismatch,
  { readonly brand: unique symbol }
>()("PlatformTableMismatch", {
  classId: Schema.String,
  problems: Schema.Array(Schema.String),
}) {
  /**
   * Lists the differences.
   * @returns The message.
   */
  override get message(): string {
    return `Platform table ${this.classId} does not match its description: ${this.problems.join("; ")}`;
  }
}
