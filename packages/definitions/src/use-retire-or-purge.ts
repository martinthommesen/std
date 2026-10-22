/**
 * `UseRetireOrPurge` (Contracts 1.4, HTTP 409): an ordinary delete must
 * never destroy a column.
 */
import { String as SchemaString, TaggedError } from "effect/Schema";

/**
 * A `DELETE` of a field, table or namespace definition: retire the
 * definition, then purge it.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class UseRetireOrPurge extends TaggedError<
  UseRetireOrPurge,
  { readonly brand: unique symbol }
>()("UseRetireOrPurge", {
  definitionId: SchemaString,
  kind: SchemaString,
}) {
  /**
   * Names the definition.
   *
   * @returns The message.
   */
  override get message(): string {
    return `A ${this.kind} definition (${this.definitionId}) is never deleted; retire it, then purge it.`;
  }
}
