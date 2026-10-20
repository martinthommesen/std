/**
 * `ExistingDataViolates`: a tightening that existing rows violate (Contracts 1.4).
 */
import { Schema } from "effect";

/**
 * Existing rows violate a tightening (a required field without a default on
 * a table with rows, a new override, a narrower max length). Found by the
 * preflight under `SCHEMA_KEY`, before `CONFIG_KEY` and before any DDL.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ExistingDataViolates extends Schema.TaggedError<
  ExistingDataViolates,
  { readonly brand: unique symbol }
>()("ExistingDataViolates", {
  /** How many rows violate it. */
  count: Schema.Int,
  /** The field, override or index whose rule the rows violate. */
  definitionId: Schema.String,
  /** Up to 20 IDs of violating records, in ID order. */
  sampleIds: Schema.Array(Schema.String),
}) {
  /**
   * Names the definition and the count only, never values.
   * @returns The message.
   */
  override get message(): string {
    return `${this.count} existing records violate ${this.definitionId}`;
  }
}
