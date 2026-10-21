/**
 * `RecordInSave` (Contracts 4.1).
 */
import { Schema } from "effect";

/**
 * A nested save (from a hook) targets a record that an enclosing save of
 * the same transaction is saving. It fails the outer save.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class RecordInSave extends Schema.TaggedError<
  RecordInSave,
  { readonly brand: unique symbol }
>()("RecordInSave", {}) {
  /** A fixed message that names nothing. */
  override readonly message =
    "The record is already being saved in this transaction";
}
