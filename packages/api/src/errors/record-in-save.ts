/**
 * `RecordInSave` (Contracts 4.1, HTTP 422 [judgment, decision 0022]).
 */
import { Schema } from "effect";

/**
 * A nested save (from a hook or record rule) targets a record that an
 * enclosing save of the same transaction is saving. It fails the outer
 * save. Names no record.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class RecordInSave extends Schema.TaggedError<
  RecordInSave,
  { readonly brand: unique symbol }
>()("RecordInSave", {}, { httpApiStatus: 422 }) {
  /** A fixed message that names nothing. */
  override readonly message =
    "The record is already being saved in this transaction";
}
